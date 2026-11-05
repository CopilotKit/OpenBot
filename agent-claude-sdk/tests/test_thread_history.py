"""The conversation a Bot answers from is the one the server sends, on every run.

OpenBot restores a thread from Intelligence and sends all of it in `input.messages`. Nothing may
depend on this process remembering an earlier run: a restart, or the upstream adapter dropping an
idle worker after 30 minutes, would otherwise leave the Bot answering the newest message alone.

No provider requests, credentials, or Claude subprocesses: a controlled SDK client records what
each query was given.
"""

import asyncio
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
                {"id": "standing", "role": "system", "content": "STANDING_ROLE_MARKER"},
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
