"""A Bot that holds many apps still starts, and one that cannot start says so.

FOUND LIVE. A Claude Agent SDK Bot holding HubSpot (344 tools), Notion (78) and Google Calendar (50)
was asked to sign in to a site and the window showed nothing. The harness logged `Failed to start
Claude Code: [Errno 7] Argument list too long`. The SDK starts Claude Code with the system prompt
as one `--system-prompt` argument and every allowed tool joined into one `--allowedTools`
argument, and Linux refuses to exec any single argument over 128 KiB (`MAX_ARG_STRLEN`, 131072
bytes including its terminating NUL). The full Bot's system prompt carries its standing role, a
line naming every tool it is offered, and every context entry of the run: the browser's generative
UI schema (about 37 KB) and guidelines (about 13 KB), personal memory (up to 24,000 characters,
fed by each app connected), learned skills.

The command checked here is the one the SDK's own transport builds from the options the adapter
hands Claude Code, and it is executed for real, with `true` in place of `claude`. On Linux that
exec is the one that failed; everywhere, no argument may exceed the limit.
"""

import asyncio
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import claude_agent_sdk
import pytest
from ag_ui.core import RunAgentInput
from claude_agent_sdk import (
    AssistantMessage,
    CLIConnectionError,
    ResultMessage,
    TextBlock,
)
from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import START_FAILED, OpenBotClaudeAgentAdapter
from test_tool_continuation import started_with

# Linux `MAX_ARG_STRLEN`: the most bytes one argv string may hold, its NUL included.
MAX_ARG_STRLEN = 32 * 4096

# Shaped like the live catalogue: `mcp__<server>__<vendor action>`, as `toolNameFor` builds it.
APPS = {
    "composio-hubspot": ("HUBSPOT_RETRIEVE_BATCH_OF_OBJECTS_BY_ID", 344),
    "notion": ("notion-update-database-view", 78),
    "composio-googlecalendar": ("GOOGLECALENDAR_EVENTS_LIST", 50),
}


def tool_names(per_app=1):
    return [
        f"mcp__{server}__{action}_{index}"
        for server, (action, count) in APPS.items()
        for index in range(count * per_app)
    ]


def holdings(names):
    """The server's granted-tools message (`grantedToolGuidance`): every offered tool, by system."""
    systems = {}
    for name in names:
        server, action = name.removeprefix("mcp__").split("__", 1)
        systems.setdefault(server, []).append(action)
    return "You can reach these systems directly, as the person asking, with their own access:\n" + "\n".join(
        f"- {server}: {', '.join(actions)}" for server, actions in systems.items()
    )


def large_run(names, run="run-1"):
    return RunAgentInput.model_validate(
        {
            "threadId": "thread-large",
            "runId": run,
            "state": {},
            "messages": [
                {"id": "standing-role:picked-harness", "role": "system", "content": "STANDING_ROLE_MARKER " + "r" * 5_000},
                {"id": "granted-tools:picked-harness", "role": "system", "content": holdings(names)},
                {"id": "user-1", "role": "user", "content": "Sign in to the test portal."},
            ],
            "tools": [
                {
                    "name": name,
                    "description": "An app action. " * 20,
                    "parameters": {"type": "object", "properties": {"id": {"type": "string"}}},
                }
                for name in names
            ],
            "context": [
                {"description": "Generative UI component schema", "value": "s" * 36_573},
                {"description": "Generative UI guidelines", "value": "g" * 13_198},
                {"description": "OpenBot personal memory", "value": json.dumps([{"content": "m" * 24_000}])},
                {"description": "OpenBot learned skills", "value": "LEARNED_SKILLS_MARKER " + "k" * 40_000},
            ],
            "forwardedProps": {},
        }
    )


@pytest.fixture
def started(monkeypatch):
    """Claude SDK clients whose `connect` execs the command the SDK would start Claude Code with."""
    clients = []
    true = shutil.which("true")

    class Client:
        def __init__(self, options):
            self.options = options
            self.command = None
            self.system_prompt = None
            clients.append(self)

        async def connect(self):
            options = self.options
            options.cli_path = "/not-executed/claude"
            self.command = SubprocessCLITransport(prompt="", options=options)._build_command()
            try:
                # The real exec, as the SDK's `connect` makes it, with the same argv and environment.
                subprocess.run([true, *self.command[1:]], check=True, env=dict(os.environ))
            except OSError as error:
                # How SDK 0.2.152 reports a process it could not start (subprocess_cli.py).
                raise CLIConnectionError(f"Failed to start Claude Code: {error}") from error
            self.system_prompt = started_with(options)

        async def disconnect(self):
            pass

        async def interrupt(self):
            pass

        async def query(self, prompt, session_id):
            if not isinstance(prompt, str):
                async for _ in prompt:
                    pass

        async def receive_response(self):
            yield AssistantMessage(content=[TextBlock(text="Signed in.")], model="controlled-sdk")
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="thread-large",
            )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)
    return clients


async def events(adapter, input_data):
    async with asyncio.timeout(5):
        return [event async for event in adapter.run(input_data)]


@pytest.mark.parametrize("model_only", [False, True])
@pytest.mark.parametrize(
    "per_app",
    [
        1,  # The live app catalogue (472 tools), with context that takes the system prompt past 128 KiB.
        5,  # Five times as many: `--allowedTools` alone would pass 128 KiB.
    ],
)
def test_a_bot_holding_many_apps_still_starts(started, model_only, per_app):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="large", model_only=model_only)
        try:
            names = tool_names(per_app)
            finished = await events(adapter, large_run(names))

            command = started[-1].command
            assert command is not None
            too_long = {
                command[index - 1]: len(argument.encode()) + 1
                for index, argument in enumerate(command)
                if len(argument.encode()) + 1 > MAX_ARG_STRLEN
            }
            assert too_long == {}, f"argv strings over the Linux limit: {too_long}"
            assert [event.type for event in finished][-1] == "RUN_FINISHED"
            # Everything still reaches Claude Code, from the file it reads at start.
            if not model_only:
                assert "STANDING_ROLE_MARKER" in started[-1].system_prompt
                assert f"- composio-hubspot: {names[0].split('__', 2)[2]}" in started[-1].system_prompt
            assert "LEARNED_SKILLS_MARKER" in started[-1].system_prompt
            # The file is removed once the query is over.
            assert not Path(started[-1].options.system_prompt["path"]).exists()
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("model_only", [False, True])
def test_a_bot_that_cannot_start_says_so_in_the_conversation(monkeypatch, model_only):
    class Client:
        def __init__(self, options):
            self.options = options

        async def connect(self):
            raise CLIConnectionError("Failed to start Claude Code: [Errno 7] Argument list too long")

        async def disconnect(self):
            pass

        async def interrupt(self):
            pass

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="unstartable", model_only=model_only)
        try:
            finished = await events(adapter, large_run(tool_names()))
            assert [event.type for event in finished][0] == "RUN_STARTED"
            assert finished[-1].type == "RUN_ERROR"
            assert finished[-1].message == START_FAILED
            assert finished[-1].code == "OPENBOT_HARNESS_START_FAILED"
            assert "Errno" not in finished[-1].message
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
