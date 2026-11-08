"""A model provider's refusal ends the run as one, never as the Bot's answer.

FOUND LIVE. Claude Code answers a refusal with an assistant message of its own, marked with `error`,
and the run finished as if the Bot had answered: "API Error: Request rejected (429) · This request
would exceed the rate limit …" sat in the conversation as its reply, and was sent back to the model as
history on the next turn. The texts below are what Claude Code 2.1.259 (bundled with
claude-agent-sdk 0.2.152) wrote when the Anthropic API answered with each refusal, captured on
2026-11-07 against a local stub serving Anthropic's real error bodies, each cut where it goes on to
advice of its own. The server says each in words (server/src/agents/provider-refusal.ts).
"""

import asyncio
import sys
from pathlib import Path

import claude_agent_sdk
import pytest
from ag_ui.core import RunAgentInput
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter

REFUSALS = [
    (
        "rate_limit",
        "API Error: Request rejected (429) · This request would exceed the rate limit for your "
        "organization (0000) of 30,000 input tokens per minute. For details, refer to: "
        "https://docs.claude.com/en/api/rate-limits.",
    ),
    ("billing_error", "Credit balance is too low"),
    (
        "invalid_request",
        "There's an issue with the selected model (claude-opus-5[1m]). It may not exist or you "
        "may not have access to it.",
    ),
    (
        "invalid_request",
        "Prompt is too long · the request is ~210345 tokens (limit 200000) but this conversation "
        "is only ~1203 tokens",
    ),
    (
        "invalid_request",
        "Request too large (max 32MB). Accumulated images and attachments in the conversation "
        "pushed the request over the limit.",
    ),
    (
        "server_error",
        "API Error: 500 Internal server error. This is a server-side issue, usually temporary",
    ),
    ("server_error", "API Error: Repeated 529 Overloaded errors. The API is at capacity"),
]


def refused(monkeypatch, error, text):
    """Claude Code, answering every query with its message for one refusal."""

    class Client:
        def __init__(self, options):
            self.options = options

        async def connect(self):
            pass

        async def disconnect(self):
            pass

        async def interrupt(self):
            pass

        async def query(self, prompt, session_id):
            if not isinstance(prompt, str):
                async for _ in prompt:
                    pass

        async def receive_response(self):
            yield AssistantMessage(
                content=[TextBlock(text=text)], model="<synthetic>", error=error
            )
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=True,
                num_turns=1,
                session_id="thread-refused",
                result=text,
            )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)


def ask():
    return RunAgentInput.model_validate(
        {
            "threadId": "thread-refused",
            "runId": "run-1",
            "state": {},
            "messages": [{"id": "user-1", "role": "user", "content": "Hello?"}],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
    )


@pytest.mark.parametrize("model_only", [False, True])
@pytest.mark.parametrize("error,text", REFUSALS)
def test_a_provider_refusal_ends_the_run_as_a_refusal(monkeypatch, model_only, error, text):
    refused(monkeypatch, error, text)

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="refused", model_only=model_only)
        try:
            async with asyncio.timeout(5):
                return [event async for event in adapter.run(ask())]
        finally:
            await adapter.shutdown()

    events = asyncio.run(scenario())
    assert events[-1].type == "RUN_ERROR", [event.type for event in events]
    assert events[-1].code == "OPENBOT_MODEL_REFUSED"
    # Claude Code's words go to the server, which keeps them for its log.
    assert events[-1].message == text
    # And never into the conversation as the Bot's reply.
    assert not [
        event
        for event in events
        if event.type in ("TEXT_MESSAGE_CONTENT", "MESSAGES_SNAPSHOT")
    ]
