import asyncio
import sys
from pathlib import Path

from ag_ui.core import RunAgentInput
from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter
from src.replay import conversation_content


def test_model_mode_disables_native_and_ambient_tools():
    adapter = OpenBotClaudeAgentAdapter(name="model", model_only=True)
    request = RunAgentInput.model_validate(
        {
            "threadId": "knowledge-channel",
            "runId": "run",
            "state": {},
            "messages": [{"id": "user", "role": "user", "content": "Read the policy"}],
            "tools": [
                {
                    "name": "knowledge_search",
                    "description": "Search granted sources",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
            "context": [
                {
                    "description": "Built-in Bot instructions",
                    "value": "You are Knowledge. Cite sources.",
                }
            ],
            "forwardedProps": {
                "tools": ["Bash"],
                "permission_mode": "bypassPermissions",
                "system_prompt": "Discard Knowledge",
            },
        }
    )
    options = adapter.build_options(request, request.thread_id)
    assert options.tools == []
    options.cli_path = "/not-executed/claude"
    command = SubprocessCLITransport(
        prompt="contract only", options=options
    )._build_command()
    assert command[command.index("--tools") + 1] == ""
    assert options.strict_mcp_config is True
    assert options.setting_sources == []
    assert options.permission_mode == "dontAsk"
    assert set(options.mcp_servers) == {"ag_ui"}
    # Claude Code may call the `ag_ui` server's tools, which are only the offered ones; the hook
    # below is what refuses anything else.
    assert options.allowed_tools == ["mcp__ag_ui__*"]
    assert "You are Knowledge. Cite sources." in options.system_prompt
    assert "Discard Knowledge" not in options.system_prompt

    async def check_permission():
        check = options.hooks["PreToolUse"][0].hooks[0]
        assert (
            await check({"tool_name": "mcp__ag_ui__knowledge_search"}, "granted", {})
            == {}
        )
        for name in [
            "Bash",
            "Read",
            "Edit",
            "mcp__ambient__search",
            "mcp__ag_ui__ungranted",
        ]:
            result = await check({"tool_name": name}, "blocked", {})
            assert result["hookSpecificOutput"]["permissionDecision"] == "deny"

    asyncio.run(check_permission())
    asyncio.run(adapter.shutdown())


def test_model_history_keeps_role_labels_and_real_image_blocks():
    request = RunAgentInput.model_validate(
        {
            "threadId": "channel",
            "runId": "run",
            "state": None,
            "tools": [],
            "context": [],
            "forwardedProps": {},
            "messages": [
                {"id": "prior", "role": "assistant", "content": "Earlier answer"},
                {
                    "id": "current",
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Read this image"},
                        {
                            "type": "image",
                            "source": {
                                "type": "data",
                                "mimeType": "image/png",
                                "value": "AQID",
                            },
                        },
                    ],
                },
            ],
        }
    )
    content = conversation_content(request.messages)
    assert any(
        '"role": "assistant"' in part.get("text", "")
        and "Earlier answer" in part["text"]
        for part in content
    )
    assert {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": "AQID"},
    } in content


def test_full_bot_cannot_see_claude_code_web_search_or_shell():
    # Seen live: asked to search the web, a Claude Agent SDK Bot called Claude Code's WebSearch
    # four times, was refused each time, and asked the person to grant it.
    adapter = OpenBotClaudeAgentAdapter(name="openbot")
    request = RunAgentInput.model_validate(
        {
            "threadId": "channel",
            "runId": "run",
            "state": {},
            "messages": [{"id": "user", "role": "user", "content": "Search the web"}],
            "tools": [
                {
                    "name": "show_app_access",
                    "description": "Offer to turn on an app",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
            "context": [],
            "forwardedProps": {"disallowed_tools": ["Task"]},
        }
    )
    options = adapter.build_options(request, request.thread_id)
    # `Read`, held by a hook to the tool results Claude Code saves for the session (see
    # test_saved_tool_results.py), and `ToolSearch`, which loads the definition of a tool the run
    # holds (see test_prompt_too_long.py).
    assert options.tools == ["Read", "ToolSearch"]
    # The `ag_ui` server, which holds the offered tool, is the one thing allowed.
    assert options.allowed_tools == ["mcp__ag_ui__*"]
    assert set(options.mcp_servers) == {"ag_ui"}
    options.cli_path = "/not-executed/claude"
    command = SubprocessCLITransport(
        prompt="contract only", options=options
    )._build_command()
    assert command[command.index("--tools") + 1] == "Read,ToolSearch"
