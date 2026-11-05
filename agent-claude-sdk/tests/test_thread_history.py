"""The conversation a Bot answers from is the one the server sends, on every run.

OpenBot restores a thread from Intelligence and sends all of it in `input.messages`. Nothing may
depend on this process remembering an earlier run: a restart, or the upstream adapter dropping an
idle worker after 30 minutes, would otherwise leave the Bot answering the newest message alone.

No provider requests, credentials, or Claude subprocesses: a controlled SDK client records what
each query was given.
"""

import asyncio
import json
import sys
from pathlib import Path

import claude_agent_sdk
import pytest
from ag_ui.core import RunAgentInput
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter


def thread(*turns, context="CATALOG_V1", run="run-1"):
    return RunAgentInput.model_validate(
        {
            "threadId": "thread-a",
            "runId": run,
            "state": {},
            "messages": [
                # The id the server gives a remote Bot's standing role (`standingRoleMessage`).
                {"id": "standing-role:bot_1", "role": "system", "content": "STANDING_ROLE_MARKER"},
                *[
                    {"id": f"m{index}", "role": role, "content": content}
                    for index, (role, content) in enumerate(turns)
                ],
            ],
            "tools": [],
            "context": [{"description": "OpenBot learned skills", "value": context}],
            "forwardedProps": {},
        }
    )


@pytest.fixture
def sdk(monkeypatch):
    clients = []

    class Client:
        def __init__(self, options):
            self.options = options
            self.prompts = []
            clients.append(self)

        async def connect(self):
            pass

        async def disconnect(self):
            pass

        async def interrupt(self):
            pass

        async def query(self, prompt, session_id):
            if isinstance(prompt, str):
                self.prompts.append(prompt)
                return
            text = []
            async for message in prompt:
                for part in message["message"]["content"]:
                    if part["type"] == "text":
                        text.append(part["text"])
            self.prompts.append("\n".join(text))

        async def receive_response(self):
            yield AssistantMessage(content=[TextBlock(text="ok")], model="controlled-sdk")
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="thread-a",
            )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)
    return clients


async def events(adapter, input_data):
    async with asyncio.timeout(2):
        return [event async for event in adapter.run(input_data)]


def test_a_fresh_process_answers_from_the_whole_thread(sdk):
    """What a restart looks like from here: a new adapter, a thread with history in it."""

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            finished = await events(
                adapter,
                thread(
                    ("user", "What is your favorite animal?"),
                    ("assistant", "Octopuses, easily."),
                    ("user", "What was your favorite animal again?"),
                ),
            )
            assert finished[-1].type == "RUN_FINISHED"
            prompt = sdk[-1].prompts[-1]
            assert "What is your favorite animal?" in prompt
            assert "Octopuses, easily." in prompt
            assert "What was your favorite animal again?" in prompt
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_the_standing_role_reaches_the_system_prompt(sdk):
    """The server sends a remote Bot its standing role as a system message, first, every run."""

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            await events(adapter, thread(("user", "Hello")))
            assert "STANDING_ROLE_MARKER" in str(sdk[-1].options.system_prompt)
            assert "STANDING_ROLE_MARKER" not in sdk[-1].prompts[-1], (
                "instructions belong in the system prompt, not in the replayed conversation"
            )
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_each_run_replays_once_and_sees_the_current_grants(sdk):
    """A second run on a live process neither doubles the history nor keeps the old context."""

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            await events(adapter, thread(("user", "First question")))
            await events(
                adapter,
                thread(
                    ("user", "First question"),
                    ("assistant", "ok"),
                    ("user", "Second question"),
                    context="CATALOG_V2",
                    run="run-2",
                ),
            )
            prompt = sdk[-1].prompts[-1]
            assert prompt.count("First question") == 1
            assert "Second question" in prompt
            assert "CATALOG_V2" in str(sdk[-1].options.system_prompt)
            assert "CATALOG_V1" not in str(sdk[-1].options.system_prompt)
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_state_still_reaches_the_bot(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        request = thread(("user", "Hello")).model_copy(update={"state": {"step": 2}})
        try:
            finished = await events(adapter, request)
            assert any(
                event.type == "STATE_SNAPSHOT" and event.snapshot == {"step": 2}
                for event in finished
            )
            assert "step" in str(sdk[-1].options.system_prompt)
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def run_input(*messages):
    return RunAgentInput.model_validate(
        {
            "threadId": "thread-a",
            "runId": "run-1",
            "state": {},
            "messages": list(messages),
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
    )


def say(role, content, id=None, **fields):
    return {"id": id or f"{role}-{content[:24]}", "role": role, "content": content, **fields}


def test_only_the_servers_own_system_messages_reach_the_system_prompt(sdk):
    """The browser inserts system rows too (a skill's instructions do), and so could anyone else.

    Only the two the server writes, by their ids, may set the Bot's instructions. Any other system
    row is part of the conversation: replayed as a labelled entry, never dropped, never promoted.
    """
    skill = say("system", "SKILL_INSTRUCTIONS_MARKER", id="skill-receipts")
    request = run_input(
        say("system", "STANDING_ROLE_MARKER", id="standing-role:bot_1"),
        say("system", "GRANTED_TOOLS_MARKER", id="granted-tools:bot_1"),
        skill,
        say("user", "Sort these receipts."),
    )

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            built = str(adapter.build_options(request, "thread-a").system_prompt)
            assert "STANDING_ROLE_MARKER" in built
            assert "GRANTED_TOOLS_MARKER" in built
            assert "SKILL_INSTRUCTIONS_MARKER" not in built

            finished = await events(adapter, request)
            assert finished[-1].type == "RUN_FINISHED"
            system_prompt = str(sdk[-1].options.system_prompt)
            assert "STANDING_ROLE_MARKER" in system_prompt
            assert "GRANTED_TOOLS_MARKER" in system_prompt
            assert "SKILL_INSTRUCTIONS_MARKER" not in system_prompt
            prompt = sdk[-1].prompts[-1]
            assert json.dumps(skill) in prompt, "the skill row stays in the history, labelled system"
            assert "STANDING_ROLE_MARKER" not in prompt
            assert "GRANTED_TOOLS_MARKER" not in prompt
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_a_thread_over_the_budget_replays_its_newest_messages(sdk):
    """On main a warm worker's CLI compacted on its own. Replayed whole, a long thread would outgrow
    the context window and fail every turn, which is worse than forgetting its oldest messages."""
    turns = []
    for index in range(400):
        turns.append(("user", f"QUESTION_{index:03d} " + "q" * 2000))
        turns.append(("assistant", f"ANSWER_{index:03d} " + "a" * 2000))
    turns.append(("user", "LATEST_QUESTION"))

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            finished = await events(adapter, thread(*turns))
            assert finished[-1].type == "RUN_FINISHED"
            prompt = sdk[-1].prompts[-1]
            assert "LATEST_QUESTION" in prompt
            assert "ANSWER_399" in prompt
            assert "QUESTION_000" not in prompt
            # Well inside the smallest window Claude Code runs at, 200K tokens, at the documented
            # 2.5 characters per token of the current tokenizer.
            assert len(prompt) < 200_000 * 2.5
            # And the Bot is told, before the history starts, that it is not the whole thread.
            assert "not shown" in prompt
            assert prompt.index("not shown") < prompt.index("QUESTION_")
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_the_bound_never_separates_a_tool_call_from_its_result(sdk):
    from src.replay import CHARS_PER_TOKEN, REPLAY_BUDGET_TOKENS

    budget = int(REPLAY_BUDGET_TOKENS * CHARS_PER_TOKEN)
    call = {
        "id": "call-big",
        "type": "function",
        "function": {"name": "lookup", "arguments": json.dumps({"q": "x" * int(budget * 0.3)})},
    }
    request = run_input(
        say("user", "OLD_QUESTION"),
        say("user", "TOOL_QUESTION"),
        # Newest first, the result fits the budget and its call does not: keeping the newest
        # messages that fit would keep a result whose call is gone.
        say("assistant", "", id="assistant-call", toolCalls=[call]),
        say("tool", "RESULT_BIG " + "r" * int(budget * 0.8), id="tool-big", toolCallId="call-big"),
        say("assistant", "AFTER_TOOL"),
        say("user", "LATEST_QUESTION"),
    )

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            await events(adapter, request)
            prompt = sdk[-1].prompts[-1]
            assert "LATEST_QUESTION" in prompt
            assert "AFTER_TOOL" in prompt
            assert "RESULT_BIG" not in prompt
            assert "call-big" not in prompt
            assert "OLD_QUESTION" not in prompt
            assert "not shown" in prompt
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_the_bound_keeps_everything_from_the_latest_user_message_on(sdk):
    """The person's newest message, and the tool calls and results a turn has made since, are what
    the Bot is answering. They are replayed whole even when they alone are over the budget."""
    from src.replay import CHARS_PER_TOKEN, REPLAY_BUDGET_TOKENS

    budget = int(REPLAY_BUDGET_TOKENS * CHARS_PER_TOKEN)
    call = {
        "id": "call-tail",
        "type": "function",
        "function": {"name": "computer_navigate", "arguments": "{}"},
    }
    request = run_input(
        say("user", "OLD_QUESTION"),
        say("assistant", "OLD_ANSWER"),
        say("user", "LATEST_QUESTION " + "l" * int(budget * 0.6)),
        say("assistant", "", id="assistant-tail", toolCalls=[call]),
        say("tool", "TAIL_RESULT " + "t" * int(budget * 0.6), id="tool-tail", toolCallId="call-tail"),
        say("assistant", "TAIL_ANSWER"),
    )

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            await events(adapter, request)
            prompt = sdk[-1].prompts[-1]
            for kept in ("LATEST_QUESTION", "call-tail", "TAIL_RESULT", "TAIL_ANSWER"):
                assert kept in prompt
            assert "OLD_QUESTION" not in prompt
            assert "OLD_ANSWER" not in prompt
            assert "not shown" in prompt
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
