"""A large tool result reaches the Bot, and stays in the conversation's history.

Claude Code saves a tool result over its threshold (50,000 characters, or 25,000 estimated tokens
for an MCP tool) to `<config>/projects/<cwd>/<session>/tool-results/` and shows the model a preview
and the path, and that notice is what the turn kept as the call's result. A full Bot was given no
built-in tools, so it had nothing that could open the file: it tried its computer's `Read file`,
which OpenBot refused for a path outside the Bot's workspace, then `grep` on its computer, a
different machine, and lost the result.

No provider requests or Claude subprocesses. The tool list is read through the SDK's own bridge,
which is what answers Claude Code's `tools/list`; the controlled client saves a result over the
tool's threshold as Claude Code 2.1.259 does (measured live: 129,331 characters from an MCP tool
came back as "Output has been saved to …/tool-results/…", and inline with `maxResultSizeChars`); and
the `Read` hook is called with the input Claude Code gives a PreToolUse hook.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

import claude_agent_sdk
from ag_ui.core import RunAgentInput
from claude_agent_sdk import ToolResultBlock, UserMessage
from claude_agent_sdk._internal.sdk_mcp_bridge import SdkMcpBridge

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import INLINE_RESULT_CHARS, READ_TOOL_NOTE, OpenBotClaudeAgentAdapter
from test_tool_continuation import request as tool_request
from test_tool_continuation import sdk, tool_name  # noqa: F401 - fixtures

# Claude Code's own threshold for a tool that names none.
CLAUDE_CODE_THRESHOLD = 50_000


def request():
    return RunAgentInput.model_validate(
        {
            "threadId": "thread-a",
            "runId": "run-1",
            "state": {},
            "messages": [{"id": "user", "role": "user", "content": "List my email"}],
            "tools": [
                {
                    "name": "gmail_list_messages",
                    "description": "List email",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
            "context": [],
            "forwardedProps": {},
        }
    )


def listed_tools(options):
    """The tools Claude Code is shown by the `ag_ui` server, as it receives them."""
    return asyncio.run(tools_list(options))


async def tools_list(options):
    bridge = SdkMcpBridge("ag_ui", options.mcp_servers["ag_ui"]["instance"])
    try:
        await bridge.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "claude-code", "version": "test"},
                },
            }
        )
        await bridge.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
        listed = await bridge.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        return listed["result"]["tools"]
    finally:
        await bridge.aclose()


def test_openbot_tools_keep_a_large_result_in_the_conversation():
    for model_only in (False, True):
        adapter = OpenBotClaudeAgentAdapter(name="test", model_only=model_only)
        tools = listed_tools(adapter.build_options(request(), "thread-a"))
        assert tools, "the ag_ui server lists the run's tools"
        for tool in tools:
            # Claude Code keeps a result inline up to this many characters (at most 500,000).
            assert tool["_meta"]["anthropic/maxResultSizeChars"] == INLINE_RESULT_CHARS
    # Above Claude Code's own threshold, which a file the Bot reads from its computer
    # (up to 64,000 bytes) crossed.
    assert CLAUDE_CODE_THRESHOLD < 64_000 < INLINE_RESULT_CHARS <= 500_000


@pytest.fixture
def saving(sdk, monkeypatch):  # noqa: F811 - the fixture imported above
    """The controlled client, saving a result over its tool's threshold as Claude Code does."""
    seen = {}

    class Saving(claude_agent_sdk.ClaudeSDKClient):
        async def receive_response(self):
            listed = await tools_list(self.options)
            threshold = (listed[0].get("_meta") or {}).get(
                "anthropic/maxResultSizeChars", CLAUDE_CODE_THRESHOLD
            )
            async for message in super().receive_response():
                if isinstance(message, UserMessage) and isinstance(message.content, list):
                    blocks = []
                    for block in message.content:
                        text = "".join(part["text"] for part in block.content)
                        if len(text) > threshold:
                            text = (
                                "<persisted-output>\nOutput too large. Full output saved to: "
                                f"/root/.claude/projects/-app/session-1/tool-results/{block.tool_use_id}.json\n"
                                "Preview (first 2KB):\n" + text[:2000] + "\n</persisted-output>"
                            )
                        seen[block.tool_use_id] = text
                        blocks.append(ToolResultBlock(tool_use_id=block.tool_use_id, content=text))
                    message = UserMessage(content=blocks)
                yield message

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Saving)
    return seen


async def events(adapter, input_data):
    async with asyncio.timeout(5):
        return [event async for event in adapter.run(input_data)]


@pytest.mark.parametrize("size", [60_000, 150_000])
def test_a_large_result_stays_whole_in_the_history(saving, size):
    """60,000 characters, a file read from the Bot's computer, reaches the model whole. 150,000 is
    saved to a file in this turn, and the history every later turn answers from still has it."""
    result = "HEAD " + "r" * size + " RESULT_TAIL"

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            await events(adapter, tool_request())
            resumed = await events(
                adapter, tool_request(run="run-2", results=[("thread-a-tool-0", result)])
            )
            if size < INLINE_RESULT_CHARS:
                assert saving["thread-a-tool-0"] == result, "the model is shown all of it"
            streamed = [
                event.content
                for event in resumed
                if event.type == "TOOL_CALL_RESULT" and event.tool_call_id == "thread-a-tool-0"
            ]
            assert streamed == [result]
            snapshots = [event for event in resumed if event.type == "MESSAGES_SNAPSHOT"]
            assert snapshots, "the turn ends with the history it keeps"
            kept = [
                message.content
                for message in snapshots[-1].messages
                if getattr(message, "tool_call_id", None) == "thread-a-tool-0"
            ]
            assert kept == [result]
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def read_hook(options):
    matchers = [
        matcher
        for matcher in (options.hooks or {}).get("PreToolUse", [])
        if matcher.matcher == "Read"
    ]
    assert matchers, "a full Bot's Read is held by a hook"
    return matchers[0].hooks[0]


def decision(hook, session_folder, path, session="session-1"):
    async def call():
        return await hook(
            {
                "hook_event_name": "PreToolUse",
                "session_id": session,
                "transcript_path": str(session_folder / f"{session}.jsonl"),
                "cwd": "/app",
                "tool_name": "Read",
                "tool_input": {"file_path": str(path)},
                "tool_use_id": "toolu_read",
            },
            "toolu_read",
            {"signal": None},
        )

    output = asyncio.run(call())
    return output["hookSpecificOutput"]["permissionDecision"]


def test_a_full_bot_can_read_back_its_own_saved_tool_result(tmp_path):
    project = tmp_path / "projects" / "-app"
    saved = project / "session-1" / "tool-results"
    saved.mkdir(parents=True)
    result = saved / "toolu_01ABC.json"
    result.write_text(json.dumps({"messages": ["SAVED_RESULT_MARKER"]}), encoding="utf-8")

    options = OpenBotClaudeAgentAdapter(name="test").build_options(request(), "thread-a")
    assert "Read" in options.tools
    # And the Bot is told what it is for, so it does not reach for it for files on its computer.
    assert READ_TOOL_NOTE in options.system_prompt
    hook = read_hook(options)

    assert decision(hook, project, result) == "allow"
    assert "SAVED_RESULT_MARKER" in result.read_text(encoding="utf-8")


def test_read_opens_nothing_but_this_sessions_saved_results(tmp_path):
    project = tmp_path / "projects" / "-app"
    saved = project / "session-1" / "tool-results"
    other = project / "session-2" / "tool-results"
    saved.mkdir(parents=True)
    other.mkdir(parents=True)
    (other / "toolu_other.json").write_text("{}", encoding="utf-8")
    (project / "session-1.jsonl").write_text("{}", encoding="utf-8")
    secret = tmp_path / "secret.txt"
    secret.write_text("no", encoding="utf-8")
    os.symlink(secret, saved / "toolu_link.json")

    hook = read_hook(OpenBotClaudeAgentAdapter(name="test").build_options(request(), "thread-a"))

    for refused in (
        "/etc/passwd",
        secret,
        project / "session-1.jsonl",  # the transcript beside the folder
        other / "toolu_other.json",  # another conversation's saved result
        saved / ".." / ".." / "session-1.jsonl",
        saved,  # the folder itself
        saved / "toolu_link.json",  # a link out of it
        "toolu_01ABC.json",  # relative, resolved against the process's directory
    ):
        assert decision(hook, project, refused) == "deny", refused
