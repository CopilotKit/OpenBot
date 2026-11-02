"""A failed tool call stays failed in the history that ends the turn.

Real AG-UI adapter and SDK message types; the Claude process is a controlled fake that answers one
turn with Claude Code's own tools, as the SDK reports them.
"""

import asyncio
import json
import sys
from pathlib import Path

import claude_agent_sdk
import pytest
from ag_ui.core import EventType, RunAgentInput
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter

# Recorded from a real run of this harness (Claude Code refusing a directory outside /app).
DENIED = (
    "mkdir in '/tmp/work' was blocked. For security, Claude Code may only create directories in "
    "the allowed working directories for this session: '/app'."
)
# A command that worked and printed an API's JSON error body.
PRINTED = '{"error": true, "message": "rate limited"}'


@pytest.fixture
def sdk(monkeypatch):
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
            self.thread = session_id

        async def receive_response(self):
            yield AssistantMessage(
                content=[
                    ToolUseBlock(id="toolu_denied", name="Bash", input={"command": "mkdir -p /tmp/work"}),
                    ToolUseBlock(id="toolu_printed", name="Bash", input={"command": "curl -s https://api.example.com"}),
                ],
                model="controlled-sdk",
            )
            yield UserMessage(
                content=[
                    ToolResultBlock(tool_use_id="toolu_denied", content=DENIED, is_error=True),
                    ToolResultBlock(tool_use_id="toolu_printed", content=PRINTED, is_error=False),
                ]
            )
            yield AssistantMessage(content=[TextBlock(text="Done.")], model="controlled-sdk")
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id=self.thread,
            )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)


async def events(adapter, input_data):
    async with asyncio.timeout(2):
        return [event async for event in adapter.run(input_data)]


def test_a_failed_tool_call_stays_failed_in_the_history(sdk):
    adapter = OpenBotClaudeAgentAdapter(name="openbot")
    request = RunAgentInput.model_validate(
        {
            "threadId": "thread-a",
            "runId": "run-1",
            "state": {},
            "messages": [{"id": "user-1", "role": "user", "content": "Make /tmp/work"}],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
    )
    stream = asyncio.run(events(adapter, request))

    live = {
        event.tool_call_id: event.content
        for event in stream
        if event.type == EventType.TOOL_CALL_RESULT
    }
    # While the turn streams, the harness marks the failure.
    assert json.loads(live["toolu_denied"]) == {"error": True, "content": DENIED}

    [snapshot] = [event for event in stream if event.type == EventType.MESSAGES_SNAPSHOT]
    history = {
        message.tool_call_id: message.content
        for message in snapshot.messages
        if message.role == "tool"
    }
    # And the history a reloaded conversation draws says the same, not Claude Code's bare text.
    assert history["toolu_denied"] == live["toolu_denied"]
    # A call that worked keeps what it returned, whatever that looks like.
    assert json.loads(history["toolu_printed"]) == json.loads(PRINTED)
