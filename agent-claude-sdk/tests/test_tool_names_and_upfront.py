"""Every tool fits the provider's name limit in Claude Code, and the Bot's own and already-used tools
load with the session instead of behind Claude Code's tool search.

FOUND IN MEASUREMENT. Claude Code names each of OpenBot's tools `mcp__ag_ui__<name>`, and Anthropic
takes at most 64 characters, so an app action named over 52 could not be loaded or called: 51 of the
647 actions Gmail, Slack, Google Sheets and HubSpot list, sixteen of them Sheets'. And every tool was
deferred behind `ToolSearch`, OpenBot's own included, so a Bot searched before it could remember a
fact, and searched again on a follow-up for the action it had just used.

Real adapter, real AG-UI and SDK message types, and a controlled SDK process boundary: the fake client
reads the tools the `ag_ui` server lists over the SDK's own JSON-RPC bridge, as the CLI does, calls
the long-named one by the name it was listed under, and runs the PostToolUse hooks, as the CLI does.
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
from claude_agent_sdk._internal.sdk_mcp_bridge import SdkMcpBridge

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import (
    ALWAYS_LOAD,
    AG_UI_TOOL_PREFIX,
    TOOL_NAME_LIMIT,
    OpenBotClaudeAgentAdapter,
    callable_name,
)

# Composio's Google Sheets action, as the server names it: 72 characters with Claude Code's prefix.
LONG = "mcp__composio-googlesheets__GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND"
LONG_TWIN = "mcp__composio-googlesheets__GOOGLESHEETS_SPREADSHEETS_VALUES_BATCH_GET_BY_DATA_FILTER"
# An app action the conversation already used, one it has not, and one of OpenBot's own.
USED = "mcp__composio-slack__SLACK_SEND_MESSAGE"
UNUSED = "mcp__composio-slack__SLACK_FIND_USERS"
OWN = "remember"


def test_a_long_name_is_cut_to_fit_and_a_short_one_is_left_alone():
    assert len(AG_UI_TOOL_PREFIX + LONG) > TOOL_NAME_LIMIT
    cut = callable_name(LONG)
    assert len(AG_UI_TOOL_PREFIX + cut) <= TOOL_NAME_LIMIT
    assert cut == callable_name(LONG), "the same name every run"
    assert cut != callable_name(LONG_TWIN), "two long names that share a start never meet"
    assert cut.startswith("mcp__composio-googlesheets__GOOGLESHEETS_")
    assert callable_name(USED) == USED


def run_input(messages):
    return RunAgentInput.model_validate(
        {
            "threadId": "thread-names",
            "runId": "run-names",
            "state": None,
            "messages": messages,
            "tools": [
                {"name": name, "description": name, "parameters": {"type": "object", "properties": {}}}
                for name in (LONG, USED, UNUSED, OWN)
            ],
            "context": [],
            "forwardedProps": {},
        }
    )


ASKED = [
    {"id": "u1", "role": "user", "content": "Post the update in #launch"},
    {
        "id": "a1",
        "role": "assistant",
        "content": "",
        "toolCalls": [
            {"id": "c1", "type": "function", "function": {"name": USED, "arguments": "{}"}}
        ],
    },
    {"id": "t1", "role": "tool", "toolCallId": "c1", "content": '{"ok":true}'},
    {"id": "u2", "role": "user", "content": "and add a row for it to the tracker sheet"},
]


async def listed(options):
    server = (options.mcp_servers or {})["ag_ui"]
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
        answer = await bridge.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    finally:
        await bridge.aclose()
    return answer["result"]["tools"]


@pytest.fixture
def sdk(monkeypatch):
    clients = []

    class Client:
        def __init__(self, options):
            self.options = options
            self.tools = []
            clients.append(self)

        async def connect(self):
            self.tools = await listed(self.options)

        async def disconnect(self):
            pass

        async def interrupt(self):
            pass

        async def set_model(self, model=None):
            pass

        async def query(self, prompt, session_id):
            self.input = [message async for message in prompt]
            self.session = session_id

        async def receive_response(self):
            # The model calls the long-named tool by the name Claude Code holds it under.
            held = next(tool["name"] for tool in self.tools if tool["name"].startswith(LONG[:30]))
            call = ToolUseBlock(id="call-long", name=f"{AG_UI_TOOL_PREFIX}{held}", input={})
            yield AssistantMessage(content=[call], model="controlled-sdk")
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
            yield UserMessage(content=[ToolResultBlock(tool_use_id=call.id, content=result)])
            yield AssistantMessage(content=[TextBlock(text="Added the row.")], model="controlled-sdk")
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id=self.session,
            )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)
    return clients


async def events(adapter, input_data):
    async with asyncio.timeout(2):
        return [event async for event in adapter.run(input_data)]


def test_every_tool_is_listed_within_the_limit_and_the_right_ones_load_upfront(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="bot")
        try:
            # The run hands the long-named call to the server and ends there.
            await events(adapter, run_input(ASKED))
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
    tools = {tool["name"]: tool for tool in sdk[0].tools}
    assert all(len(AG_UI_TOOL_PREFIX + name) <= TOOL_NAME_LIMIT for name in tools)
    assert callable_name(LONG) in tools
    upfront = {name for name, tool in tools.items() if (tool.get("_meta") or {}).get(ALWAYS_LOAD)}
    assert upfront == {OWN, USED}, "OpenBot's own and the conversation's used tools, not the rest"


def test_a_call_to_a_cut_name_reaches_the_server_by_the_name_it_was_offered(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="bot")
        try:
            return await events(adapter, run_input(ASKED))
        finally:
            await adapter.shutdown()

    seen = asyncio.run(scenario())
    started = [event.tool_call_name for event in seen if event.type == "TOOL_CALL_START"]
    assert started == [LONG]
    assert seen[-1].type == "RUN_FINISHED", "handed to the server to answer, not refused"
