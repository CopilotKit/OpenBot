"""A tool OpenBot's `search_tools` found is held, loaded and called in the same turn by a full Bot.

FOUND ON WINDOWS. A Bot on this harness, registered as an ordinary endpoint, holds many app tools
and OpenBot answers its `search_tools` itself: the search said SLACK_SEND_MESSAGE could be called
from the next step, and the next step was sent it. The full Bot resumed the query the turn started,
which never held it: Claude Code's ToolSearch found "No matching deferred tools", the call was "No
such tool available", and the Bot posted with another tool or not at all.

The model endpoint already answers such a step with a fresh query
(`test_tool_search_continuation.py`); a full Bot now does too, and the found tool loads with that
query instead of behind ToolSearch.

Real adapter, real AG-UI and SDK message types, and a controlled SDK process boundary: the fake
client calls a tool it holds by its SDK name and, holding none by that name, calls the name the search
gave, as Claude did. It runs the configured PostToolUse hooks, as the CLI does.
"""

import asyncio
import json
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
from claude_agent_sdk._internal.sdk_mcp_bridge import SdkMcpBridge

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter

SEARCH = "search_tools"
FOUND = "mcp__composio-slack__SLACK_SEND_MESSAGE"
OWN = "remember"
SEARCH_ANSWER = (
    f"Tools found: {FOUND}\n"
    'You can call them from your next step, for "send slack message".'
)


def step(run, tools, search_result=None):
    """One model step as the server's PlanModel sends it."""
    messages = [
        {
            "id": "prompt-0",
            "role": "user",
            "content": "Post in #launch that the deck is ready.",
        }
    ]
    if search_result:
        call_id, content = search_result
        messages += [
            {
                "id": "prompt-1",
                "role": "assistant",
                "content": "",
                "toolCalls": [
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": SEARCH,
                            "arguments": '{"query":"send slack message"}',
                        },
                    }
                ],
            },
            {
                "id": f"result-{call_id}",
                "role": "tool",
                "toolCallId": call_id,
                "content": content,
            },
        ]
    return RunAgentInput.model_validate(
        {
            "threadId": "plan-thread",
            "runId": run,
            "state": None,
            "messages": messages,
            "tools": [
                {
                    "name": name,
                    "description": name,
                    "parameters": {"type": "object", "properties": {}},
                }
                for name in tools
            ],
            "context": [],
            "forwardedProps": {},
        }
    )


LISTED = []


async def listed_tools(options):
    server = (options.mcp_servers or {}).get("ag_ui")
    if server is None:
        return set()
    bridge = SdkMcpBridge("ag_ui", server["instance"])
    try:
        await bridge.handle(
            {
                "jsonrpc": "2.0",
                "id": 0,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "claude-code", "version": "test"},
                },
            }
        )
        await bridge.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
        listed = await bridge.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    finally:
        await bridge.aclose()
    LISTED.append(listed["result"]["tools"])
    names = {f"mcp__ag_ui__{tool['name']}" for tool in listed["result"]["tools"]}
    # And only those an allow rule lets it call without asking (`dontAsk` refuses the rest).
    allowed = options.allowed_tools or []
    return {
        name
        for name in names
        if name in allowed or any(rule.endswith("*") and name.startswith(rule[:-1]) for rule in allowed)
    }


@pytest.fixture
def sdk(monkeypatch):
    clients = []

    class Client:
        def __init__(self, options):
            self.options = options
            self.held = set()
            self.input = []
            self.interrupted = False
            clients.append(self)

        async def connect(self):
            # What Claude Code holds is what the `ag_ui` server lists when it starts, asked over
            # the SDK's own JSON-RPC bridge, as the CLI asks it.
            self.held = await listed_tools(self.options)

        async def disconnect(self):
            pass

        async def interrupt(self):
            self.interrupted = True

        async def set_model(self, model=None):
            pass

        async def query(self, prompt, session_id):
            self.input = [message async for message in prompt]
            self.session = session_id

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
            found = FOUND if f"Tools found: {FOUND}" in json.dumps(self.input) else None
            turn = 0
            while True:
                if found is None:
                    name = f"mcp__ag_ui__{SEARCH}"
                else:
                    held = f"mcp__ag_ui__{found}"
                    name = held if held in self.held else found
                call = ToolUseBlock(
                    id=f"query-{len(clients)}-call-{turn}", name=name, input={}
                )
                turn += 1
                yield AssistantMessage(content=[call], model="controlled-sdk")
                if name not in self.held:
                    # The CLI's answer to a tool it does not have.
                    yield UserMessage(
                        content=[
                            ToolResultBlock(
                                tool_use_id=call.id,
                                content=f"No such tool available: {name}",
                                is_error=True,
                            )
                        ]
                    )
                    break
                result = await self._post_tool_use(call)
                yield UserMessage(
                    content=[ToolResultBlock(tool_use_id=call.id, content=result)]
                )
                if found is not None:
                    yield AssistantMessage(
                        content=[TextBlock(text="Posted.")],
                        model="controlled-sdk",
                    )
                    break
                if f"Tools found: {FOUND}" in json.dumps(result):
                    found = FOUND
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=turn,
                session_id=self.session,
            )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)
    return clients


async def events(adapter, input_data):
    async with asyncio.timeout(2):
        return [event async for event in adapter.run(input_data)]


def called(seen):
    return [event.tool_call_name for event in seen if event.type == "TOOL_CALL_START"]


def test_a_full_bot_holds_and_calls_what_its_search_found_in_the_same_turn(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="bot")
        try:
            first = await events(adapter, step("run-1", [SEARCH, OWN]))
            assert called(first) == [SEARCH]
            assert first[-1].type == "RUN_FINISHED"
            search_id = next(
                event.tool_call_id for event in first if event.type == "TOOL_CALL_START"
            )
            # The server sends the found tool from the step after the search on.
            second = await events(
                adapter,
                step("run-2", [SEARCH, OWN, FOUND], search_result=(search_id, SEARCH_ANSWER)),
            )
            assert called(second) == [FOUND], "called in the same turn, by the name it was offered"
            assert second[-1].type == "RUN_FINISHED"
            # A fresh query that holds it, answering from the search's real result.
            assert len(sdk) == 2
            assert sdk[0].interrupted
            assert f"mcp__ag_ui__{FOUND}" in sdk[1].held
            assert SEARCH_ANSWER.splitlines()[0] in json.dumps(sdk[1].input)
            # And loaded with the session: the model was told it can call it, so it does not have
            # to find it again with ToolSearch.
            upfront = {
                tool["name"]
                for tool in LISTED[-1]
                if (tool.get("_meta") or {}).get("anthropic/alwaysLoad")
            }
            assert FOUND in upfront and OWN in upfront and SEARCH in upfront
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_a_full_bot_sent_the_same_tools_resumes_its_query(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="bot")
        try:
            first = await events(adapter, step("run-1", [SEARCH, FOUND]))
            search_id = next(
                event.tool_call_id for event in first if event.type == "TOOL_CALL_START"
            )
            second = await events(
                adapter,
                step("run-2", [FOUND, SEARCH], search_result=(search_id, SEARCH_ANSWER)),
            )
            assert called(second) == [FOUND]
            assert len(sdk) == 1, "the same tools must not restart the SDK query"
            assert not sdk[0].interrupted
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
