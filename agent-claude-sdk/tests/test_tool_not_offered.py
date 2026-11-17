"""On the model endpoint, the server only ever hears of calls to the tools a step offered.

FOUND IN DOGFOODING. A Bot on a Claude plan, asked to find HubSpot deals and add them to a Slack
update it had already posted, worked for five minutes and then failed with "The plan harness
attempted an unoffered tool: mcp__composio-slack__SLACK_UPDATES_A_SLACK_MESSAGE". The Bot held
Slack's other actions, offered to Claude Code as `mcp__ag_ui__mcp__composio-slack__SLACK_...`, and
not that one. Claude called it anyway. Claude Code answered the call itself, "No such tool
available", and the model carried on, but upstream had already streamed the call's start, and the
server threw the whole run away on a name it had not offered.

Real AG-UI adapter and SDK message types; the Claude process is a controlled fake that answers as
Claude Code does: a call to a tool the session holds runs and waits in its PostToolUse hook for the
server's result, a call to one it does not hold gets an `is_error` result and no hook.
"""

import asyncio
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
from claude_agent_sdk.types import StreamEvent

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import AG_UI_TOOL_PREFIX, OpenBotClaudeAgentAdapter

SEND = "mcp__composio-slack__SLACK_SEND_MESSAGE"
DEALS = "mcp__composio-hubspot__HUBSPOT_SEARCH_DEALS"
UPDATE = "mcp__composio-slack__SLACK_UPDATES_A_SLACK_MESSAGE"
ANSWER = (
    "Here are the deals at S1 and later: BeyondTrust and Rhythm Innovations. I can't edit a "
    "message that's already posted in Slack. Want me to reply in its thread instead?"
)


def stream(thread, *raw):
    return [StreamEvent(uuid="stream", session_id=thread, event=event) for event in raw]


@pytest.fixture
def claude(monkeypatch):
    """Claude Code, answering with one call to `script["call"]`, named as Claude Code names it."""
    script = {}

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

        async def run_tool(self, name, tool_id):
            output = [{"type": "text", "text": "Tool call forwarded to client"}]
            for matcher in self.options.hooks.get("PostToolUse", []):
                for hook in matcher.hooks:
                    update = await hook(
                        {"hook_event_name": "PostToolUse", "tool_name": name}, tool_id, {}
                    )
                    output = update.get("hookSpecificOutput", {}).get(
                        "updatedMCPToolOutput", output
                    )
            return output[0]["text"]

        async def receive_response(self):
            thread, name, tool_id = self.thread, script["call"], "toolu_call"
            for message in stream(
                thread,
                {"type": "message_start", "message": {"id": "asked"}},
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "tool_use", "id": tool_id, "name": name},
                },
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": '{"channel":"C1"}'},
                },
                {"type": "content_block_stop", "index": 0},
                {"type": "message_stop"},
            ):
                yield message
            yield AssistantMessage(
                content=[ToolUseBlock(id=tool_id, name=name, input={"channel": "C1"})],
                model="controlled-sdk",
            )
            if name in script["held"]:
                result = await self.run_tool(name, tool_id)
                yield UserMessage(content=[ToolResultBlock(tool_use_id=tool_id, content=result)])
            else:
                yield UserMessage(
                    content=[
                        ToolResultBlock(
                            tool_use_id=tool_id,
                            content=f"<tool_use_error>Error: No such tool available: {name}</tool_use_error>",
                            is_error=True,
                        )
                    ]
                )
            for message in stream(
                thread,
                {"type": "message_start", "message": {"id": "answered"}},
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": ANSWER}},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_stop"},
            ):
                yield message
            yield AssistantMessage(content=[TextBlock(text=ANSWER)], model="controlled-sdk")
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=2,
                session_id=thread,
            )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)
    return script


def request(run="run-1", results=()):
    return RunAgentInput.model_validate(
        {
            "threadId": "thread-deals",
            "runId": run,
            "state": None,
            "messages": [
                {
                    "id": "user-1",
                    "role": "user",
                    "content": "Find all HubSpot deals at S1 and later and add them to the Slack update.",
                },
                *[
                    {"id": f"result-{tool_id}", "role": "tool", "toolCallId": tool_id, "content": text}
                    for tool_id, text in results
                ],
            ],
            "tools": [
                {"name": name, "description": name, "parameters": {"type": "object", "properties": {}}}
                for name in (SEND, DEALS)
            ],
            "context": [],
            "forwardedProps": {"openbotModelOnly": True},
        }
    )


async def events(adapter, input_data):
    async with asyncio.timeout(2):
        return [event async for event in adapter.run(input_data)]


def said(run):
    return "".join(event.delta for event in run if event.type == EventType.TEXT_MESSAGE_CONTENT)


def called(run):
    return [event.tool_call_name for event in run if event.type == EventType.TOOL_CALL_START]


def test_an_offered_tool_claude_code_calls_by_its_mcp_name_reaches_the_server_by_its_own(claude):
    claude.update(call=f"{AG_UI_TOOL_PREFIX}{SEND}", held={f"{AG_UI_TOOL_PREFIX}{SEND}"})

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="openbot", model_only=True)
        try:
            first = await events(adapter, request())
            # Claude Code's `mcp__ag_ui__mcp__composio-slack__...` is the server's own name again.
            assert called(first) == [SEND]
            assert first[-1].type == EventType.RUN_FINISHED
            resumed = await events(adapter, request("run-2", [("toolu_call", '{"ok":true}')]))
            assert ANSWER in said(resumed)
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "name",
    [
        # Through OpenBot's own server, by the name of an action the step did not offer.
        f"{AG_UI_TOOL_PREFIX}{UPDATE}",
        # By the action's name alone, as the conversation spells it.
        UPDATE,
    ],
)
def test_a_tool_the_step_did_not_offer_never_reaches_the_server_and_the_model_answers(claude, name):
    claude.update(call=name, held={f"{AG_UI_TOOL_PREFIX}{SEND}", f"{AG_UI_TOOL_PREFIX}{DEALS}"})

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="openbot", model_only=True)
        try:
            run = await events(adapter, request())
            offered = {SEND, DEALS}
            # The server hears of no call it did not offer, nor of Claude Code's answer to one.
            assert set(called(run)) <= offered
            assert not any(
                event.type
                in (EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT)
                for event in run
            )
            # The model was told, and answered in the same run.
            assert ANSWER in said(run)
            assert run[-1].type == EventType.RUN_FINISHED
            assert not any(event.type == EventType.RUN_ERROR for event in run)
            assert "thread-deals" not in adapter._turns
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
