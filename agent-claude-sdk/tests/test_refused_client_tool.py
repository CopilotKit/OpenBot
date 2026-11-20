"""A client tool call Claude Code refuses itself does not end the turn in silence.

The model called the table with input that was not JSON (its `columns` array lost both brackets).
Claude Code refused the call before running it, so nothing waited on the browser. The run still
ended on the call as if the browser had a step to answer, the browser had nothing to run and sent
no run back, and the model's own answer to the refusal never reached the person.

Real AG-UI adapter and SDK message types; the Claude process is a controlled fake that answers as
Claude Code 2.1.259 does (recorded through the real CLI): a refused call gets an `is_error` result
and its PostToolUse hook never runs, while a call it runs waits in that hook for the browser.
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
from claude_agent_sdk.types import StreamEvent

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter

BROKEN = '{"title":"Weekend picks in Chicago","columns":"Event","When","Where"],"rows":[]}'
GOOD = '{"title":"Weekend picks in Chicago","columns":["Event"],"rows":[]}'
# Claude Code 2.1.259's refusal, in the words the real CLI used for input like this.
REFUSED = (
    "<tool_use_error>InputValidationError: mcp__ag_ui__showTable was called with input that could "
    "not be parsed as JSON.\nYou sent (first 80 of 80 bytes): " + BROKEN + "\nCommon causes: "
    "unescaped backslashes in file paths (use / or \\\\), unescaped control characters, or "
    "truncated output. Retry with valid JSON.</tool_use_error>"
)
ANSWER = "The table didn't draw, so here are the picks as text: 1. Marathon expo, Sat 10am."
DRAWN = "The sortable table is now on screen for the person."


def stream(thread, *raw):
    return [StreamEvent(uuid="stream", session_id=thread, event=event) for event in raw]


def tool_block(index, tool_id, partial):
    return [
        {
            "type": "content_block_start",
            "index": index,
            "content_block": {"type": "tool_use", "id": tool_id, "name": "mcp__ag_ui__showTable"},
        },
        {
            "type": "content_block_delta",
            "index": index,
            "delta": {"type": "input_json_delta", "partial_json": partial},
        },
        {"type": "content_block_stop", "index": index},
    ]


def text_message(thread, text):
    return [
        *stream(
            thread,
            {"type": "message_start", "message": {"id": f"message-{len(text)}"}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_stop"},
        ),
        AssistantMessage(content=[TextBlock(text=text)], model="controlled-sdk"),
    ]


@pytest.fixture
def claude(monkeypatch):
    """Claude Code, answering one message with the calls in `calls`: (id, input, runs it)."""
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

        async def run_tool(self, tool_id):
            # Claude Code's PostToolUse stage for a call it ran: the hook waits for the browser.
            output = [{"type": "text", "text": "Tool call forwarded to client"}]
            for matcher in self.options.hooks.get("PostToolUse", []):
                for hook in matcher.hooks:
                    update = await hook(
                        {"hook_event_name": "PostToolUse", "tool_name": "mcp__ag_ui__showTable"},
                        tool_id,
                        {},
                    )
                    output = update.get("hookSpecificOutput", {}).get("updatedMCPToolOutput", output)
            return output[0]["text"]

        async def receive_response(self):
            thread, calls = self.thread, script["calls"]
            refusals = UserMessage(
                content=[
                    ToolResultBlock(tool_use_id=tool_id, content=REFUSED, is_error=True)
                    for tool_id, _, runs in calls
                    if not runs
                ]
            )
            blocks = [
                event
                for index, (tool_id, partial, _) in enumerate(calls)
                for event in tool_block(index, tool_id, partial)
            ]
            for message in stream(thread, {"type": "message_start", "message": {"id": "asked"}}, *blocks):
                yield message
            # Claude Code checks each call's input as its block ends, before the message does.
            if script["refused_before_stop"] and refusals.content:
                yield refusals
            for message in stream(thread, {"type": "message_stop"}):
                yield message
            yield AssistantMessage(
                content=[ToolUseBlock(id=tool_id, name="mcp__ag_ui__showTable", input={}) for tool_id, _, _ in calls],
                model="controlled-sdk",
            )
            if not script["refused_before_stop"] and refusals.content:
                yield refusals
            ran = [tool_id for tool_id, _, runs in calls if runs]
            if ran:
                results = await asyncio.gather(*(self.run_tool(tool_id) for tool_id in ran))
                yield UserMessage(
                    content=[ToolResultBlock(tool_use_id=tool_id, content=text) for tool_id, text in zip(ran, results)]
                )
            # The model answers what it was told: a refusal, or the table on screen.
            for message in text_message(thread, ANSWER if not ran else "The table is on screen."):
                yield message
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
            "threadId": "thread-weekend",
            "runId": run,
            "state": {},
            "messages": [
                {"id": "user-1", "role": "user", "content": "Find three things to do this weekend."},
                *[
                    {"id": f"result-{tool_id}", "role": "tool", "toolCallId": tool_id, "content": text}
                    for tool_id, text in results
                ],
            ],
            "tools": [
                {
                    "name": "showTable",
                    "description": "Show a sortable table.",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
            "context": [],
            "forwardedProps": {},
        }
    )


async def events(adapter, input_data):
    async with asyncio.timeout(2):
        return [event async for event in adapter.run(input_data)]


def said(run):
    return "".join(event.delta for event in run if event.type == EventType.TEXT_MESSAGE_CONTENT)


@pytest.mark.parametrize("refused_before_stop", [True, False])
def test_the_model_answers_a_refused_call_in_the_same_run(claude, refused_before_stop):
    claude.update(calls=[("toolu_table", BROKEN, False)], refused_before_stop=refused_before_stop)

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="openbot")
        try:
            run = await events(adapter, request())
            # The refusal, then the model's own answer to it, and the turn's end after that.
            assert [event.content for event in run if event.type == EventType.TOOL_CALL_RESULT] == [
                json.dumps({"error": True, "content": REFUSED})
            ]
            assert ANSWER in said(run)
            assert run[-1].type == EventType.RUN_FINISHED
            assert any(event.type == EventType.MESSAGES_SNAPSHOT for event in run)
            # Nothing is left waiting on a browser that has nothing to answer.
            assert "thread-weekend" not in adapter._turns
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_a_call_claude_code_runs_still_waits_for_the_browser(claude):
    claude.update(calls=[("toolu_table", GOOD, True)], refused_before_stop=True)

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="openbot")
        try:
            first = await events(adapter, request())
            assert any(event.type == EventType.TOOL_CALL_END for event in first)
            assert first[-1].type == EventType.RUN_FINISHED
            assert not any(event.type == EventType.TOOL_CALL_RESULT for event in first)

            resumed = await events(adapter, request("run-2", [("toolu_table", DRAWN)]))
            assert [event.content for event in resumed if event.type == EventType.TOOL_CALL_RESULT] == [DRAWN]
            assert "The table is on screen." in said(resumed)
            assert resumed[-1].type == EventType.RUN_FINISHED
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_a_refused_call_beside_one_claude_code_runs_hands_over_only_that_one(claude):
    claude.update(
        calls=[("toolu_broken", BROKEN, False), ("toolu_table", GOOD, True)],
        refused_before_stop=True,
    )

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="openbot")
        try:
            first = await events(adapter, request())
            assert first[-1].type == EventType.RUN_FINISHED
            assert adapter._turns["thread-weekend"].delivered == {"toolu_table"}

            resumed = await events(adapter, request("run-2", [("toolu_table", DRAWN)]))
            assert "The table is on screen." in said(resumed)
            assert resumed[-1].type == EventType.RUN_FINISHED
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
