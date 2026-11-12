"""A step that calls one of OpenBot's tools and Claude Code's own `ToolSearch` finishes in words.

FROM A DOGFOODING REPORT. In one step the model called an app tool, which reaches this harness as a
client tool, and `ToolSearch`, which Claude Code runs itself (`TOOL_SEARCH`). Claude Code ran the
app tool first, so the run ended for its result with the search still to run. The continuation that
carries the app tool's result has to let Claude Code run the search, stream its result, and finish
the turn with the model's answer.

Real adapter, real AG-UI and SDK message types, and a controlled SDK process boundary: the fake
client runs the configured PostToolUse hooks, as the CLI does, and runs the calls of a step one at a
time, in order, as Claude Code ran these.
"""

import asyncio
import sys
from pathlib import Path

import claude_agent_sdk
import pytest
from ag_ui.core import RunAgentInput
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
from src.adapter import TOOL_SEARCH, OpenBotClaudeAgentAdapter

APP_TOOL = "SLACK_FETCH_MESSAGE_THREAD"
FETCH = "call-fetch"
SEARCH = "call-search"
ANSWER = "Saved the thread to Drive."


def request(run, results=()):
    return RunAgentInput.model_validate(
        {
            "threadId": "thread",
            "runId": run,
            "state": {},
            "messages": [
                {"id": "ask", "role": "user", "content": "Save that thread to Drive."},
                *(
                    [
                        {
                            "id": "step",
                            "role": "assistant",
                            "content": "",
                            "toolCalls": [
                                {
                                    "id": FETCH,
                                    "type": "function",
                                    "function": {"name": APP_TOOL, "arguments": "{}"},
                                },
                                {
                                    "id": SEARCH,
                                    "type": "function",
                                    "function": {
                                        "name": TOOL_SEARCH,
                                        "arguments": '{"query":"drive"}',
                                    },
                                },
                            ],
                        }
                    ]
                    if results
                    else []
                ),
                *[
                    {"id": f"result-{id}", "role": "tool", "toolCallId": id, "content": text}
                    for id, text in results
                ],
            ],
            "tools": [
                {
                    "name": APP_TOOL,
                    "description": "Fetch a message thread from a conversation",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
            "context": [],
            "forwardedProps": {},
        }
    )


@pytest.fixture
def sdk(monkeypatch):
    clients = []

    class Client:
        def __init__(self, options):
            self.options = options
            self.results = {}
            clients.append(self)

        async def connect(self):
            pass

        async def disconnect(self):
            pass

        async def interrupt(self):
            pass

        async def set_model(self, model=None):
            pass

        async def query(self, prompt, session_id):
            if not isinstance(prompt, str):
                [message async for message in prompt]

        async def _post_tool_use(self, call):
            result = [{"type": "text", "text": "Tool call forwarded to client"}]
            for matcher in (self.options.hooks or {}).get("PostToolUse", []):
                for hook in matcher.hooks:
                    update = await hook(
                        {
                            "hook_event_name": "PostToolUse",
                            "tool_name": call.name,
                            "tool_input": {},
                            "tool_response": result,
                        },
                        call.id,
                        {},
                    )
                    result = update.get("hookSpecificOutput", {}).get(
                        "updatedMCPToolOutput", result
                    )
            return result

        async def receive_response(self):
            calls = [
                ToolUseBlock(id=FETCH, name=f"mcp__ag_ui__{APP_TOOL}", input={}),
                ToolUseBlock(id=SEARCH, name=TOOL_SEARCH, input={"query": "drive"}),
            ]
            if self.options.include_partial_messages:
                events = [{"type": "message_start", "message": {"id": "step"}}]
                for index, call in enumerate(calls):
                    events += [
                        {
                            "type": "content_block_start",
                            "index": index,
                            "content_block": {
                                "type": "tool_use",
                                "id": call.id,
                                "name": call.name,
                            },
                        },
                        {
                            "type": "content_block_delta",
                            "index": index,
                            "delta": {"type": "input_json_delta", "partial_json": "{}"},
                        },
                        {"type": "content_block_stop", "index": index},
                    ]
                events += [
                    {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
                    {"type": "message_stop"},
                ]
                for event in events:
                    yield StreamEvent(uuid="stream", session_id="thread", event=event)
            yield AssistantMessage(content=calls, model="controlled-sdk")
            # The app tool first, which waits on OpenBot for its result; the search after it.
            self.results[FETCH] = await self._post_tool_use(calls[0])
            yield UserMessage(
                content=[ToolResultBlock(tool_use_id=FETCH, content=self.results[FETCH])]
            )
            yield UserMessage(
                content=[
                    ToolResultBlock(
                        tool_use_id=SEARCH, content="Found mcp__ag_ui__GOOGLEDRIVE_UPLOAD_FILE"
                    )
                ]
            )
            yield AssistantMessage(content=[TextBlock(text=ANSWER)], model="controlled-sdk")
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="thread",
            )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)
    return clients


async def events(adapter, input_data):
    async with asyncio.timeout(2):
        return [event async for event in adapter.run(input_data)]


@pytest.mark.parametrize("streaming", [False, True])
def test_the_search_runs_once_the_app_tool_result_comes_back(sdk, streaming):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(
            name="test", options={"include_partial_messages": streaming}
        )
        try:
            first = await events(adapter, request("run-1"))
            # The run ends for the app tool's result, with the search not yet run.
            assert first[-1].type == "RUN_FINISHED"
            assert {
                event.tool_call_id for event in first if event.type == "TOOL_CALL_START"
            } == {FETCH, SEARCH}
            assert not [event for event in first if event.type == "TOOL_CALL_RESULT"]

            resumed = await events(
                adapter, request("run-2", results=[(FETCH, "The thread.")])
            )
            assert sdk[0].results[FETCH] == [{"type": "text", "text": "The thread."}]
            assert len(sdk) == 1, "the result resumes the query that asked for it"
            assert any(
                event.type == "TOOL_CALL_RESULT" and event.tool_call_id == SEARCH
                for event in resumed
            )
            # And the turn ends on the model's answer, in the history the conversation keeps.
            [snapshot] = [event for event in resumed if event.type == "MESSAGES_SNAPSHOT"]
            assert snapshot.messages[-1].role == "assistant"
            assert snapshot.messages[-1].content == ANSWER
            assert resumed[-1].type == "RUN_FINISHED"
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
