"""The server's choice of model and effort reaches the Claude Code process, on both paths.

The server sends `forwardedProps.openbotModel` on every run: to `/model` for its built-in Bots on a
Claude plan, and to `/` when this harness is the Bot a person chats with. What the choice must
reach is the command the SDK starts Claude Code with (`--model`, `--effort`), so that is what is
checked, built by the SDK's own transport from the options this adapter makes. Queries run against
the controlled SDK client in `test_tool_continuation`, which runs the adapter's real hooks.
"""

import asyncio
import sys
from pathlib import Path

import pytest
from ag_ui.core import RunAgentInput
from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter
from test_tool_continuation import events, request, sdk, tool_name  # noqa: F401  (fixtures)


def run_input(forwarded_props):
    return RunAgentInput.model_validate(
        {
            "threadId": "thread",
            "runId": "run",
            "state": None,
            "messages": [{"id": "user", "role": "user", "content": "Plan my week"}],
            "tools": [],
            "context": [],
            "forwardedProps": forwarded_props,
        }
    )


def command(options):
    """The Claude Code command line the SDK builds from these options."""
    options.cli_path = "/not-executed/claude"
    return SubprocessCLITransport(prompt="contract only", options=options)._build_command()


def flag(cmd, name):
    return cmd[cmd.index(name) + 1] if name in cmd else None


@pytest.mark.parametrize("model_only", [True, False])
@pytest.mark.parametrize(
    ("choice", "model", "effort"),
    [
        ({"model": "claude-opus-5-5", "reasoningEffort": "xhigh"}, "claude-opus-5-5", "xhigh"),
        ({"model": "claude-sonnet-5", "reasoningEffort": "low"}, "claude-sonnet-5", "low"),
        ({"model": "claude-haiku-4-5"}, "claude-haiku-4-5", None),
        # Efforts Claude Code does not take are not sent: the model's own default applies.
        ({"model": "claude-haiku-4-5", "reasoningEffort": "minimal"}, "claude-haiku-4-5", None),
        ({"model": "claude-haiku-4-5", "reasoningEffort": "none"}, "claude-haiku-4-5", None),
    ],
)
def test_the_servers_choice_reaches_claude_code(model_only, choice, model, effort):
    adapter = OpenBotClaudeAgentAdapter(name="choice", model_only=model_only)
    options = adapter.build_options(run_input({"openbotModel": choice}), "thread")

    assert (options.model, options.effort) == (model, effort)
    cmd = command(options)
    assert flag(cmd, "--model") == model
    assert flag(cmd, "--effort") == effort
    asyncio.run(adapter.shutdown())


@pytest.mark.parametrize("model_only", [True, False])
@pytest.mark.parametrize(
    "props", [{}, {"openbotModel": {"model": 5}}, {"openbotModel": "claude-opus-5-5"}]
)
def test_without_a_choice_claude_code_keeps_its_own_model(model_only, props):
    adapter = OpenBotClaudeAgentAdapter(name="choice", model_only=model_only)
    cmd = command(adapter.build_options(run_input(props), "thread"))

    assert "--model" not in cmd
    assert "--effort" not in cmd
    asyncio.run(adapter.shutdown())


def test_the_servers_choice_wins_over_a_forwarded_model():
    adapter = OpenBotClaudeAgentAdapter(name="choice")
    options = adapter.build_options(
        run_input({"model": "claude-haiku-4-5", "openbotModel": {"model": "claude-opus-5-5"}}),
        "thread",
    )

    assert options.model == "claude-opus-5-5"
    asyncio.run(adapter.shutdown())


@pytest.mark.parametrize("model_only", [True, False])
def test_a_choice_changed_between_runs_starts_the_next_query_on_it(sdk, model_only):  # noqa: F811
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="choice", model_only=model_only)
        try:
            first = request(run="run-1", tool_count=0)
            first.forwarded_props = {"openbotModel": {"model": "claude-sonnet-5", "reasoningEffort": "high"}}
            assert (await events(adapter, first))[-1].type == "RUN_FINISHED"
            second = request(run="run-2", tool_count=0)
            second.forwarded_props = {"openbotModel": {"model": "claude-opus-5-5", "reasoningEffort": "low"}}
            assert (await events(adapter, second))[-1].type == "RUN_FINISHED"
            third = request(run="run-3", tool_count=0)
            third.forwarded_props = {"openbotModel": {"model": "claude-opus-5-5"}}
            assert (await events(adapter, third))[-1].type == "RUN_FINISHED"

            assert [(client.options.model, client.options.effort) for client in sdk] == [
                ("claude-sonnet-5", "high"),
                ("claude-opus-5-5", "low"),
                ("claude-opus-5-5", None),
            ]
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("model_only", [True, False])
def test_a_tool_result_sent_with_another_model_moves_the_running_query_to_it(sdk, model_only):  # noqa: F811
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="choice", model_only=model_only)
        try:
            first = request(run="run-1")
            first.forwarded_props = {"openbotModel": {"model": "claude-sonnet-5"}}
            assert any(event.type == "TOOL_CALL_END" for event in await events(adapter, first))

            same = request(run="run-2", results=[("thread-a-tool-0", "page title")])
            same.forwarded_props = {"openbotModel": {"model": "claude-opus-5-5"}}
            resumed = await events(adapter, same)

            assert resumed[-1].type == "RUN_FINISHED"
            assert len(sdk) == 1, "the tool result continues the query that asked for it"
            assert sdk[0].models_set == ["claude-opus-5-5"]
            assert sdk[0].results["thread-a-tool-0"] == [{"type": "text", "text": "page title"}]
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("model_only", [True, False])
def test_a_tool_result_on_the_same_model_leaves_the_query_alone(sdk, model_only):  # noqa: F811
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="choice", model_only=model_only)
        try:
            first = request(run="run-1")
            first.forwarded_props = {"openbotModel": {"model": "claude-sonnet-5"}}
            await events(adapter, first)
            same = request(run="run-2", results=[("thread-a-tool-0", "page title")])
            same.forwarded_props = {"openbotModel": {"model": "claude-sonnet-5"}}
            assert (await events(adapter, same))[-1].type == "RUN_FINISHED"

            assert sdk[0].models_set == []
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
