"""A Claude Agent SDK Bot starts with OpenBot's working rules, because nothing else gives it any.

This harness hands Claude Code the server's own system messages as its whole system prompt
(`system_prompt_in_file`), which replaces Claude Code's own. So "act when you have enough", "report
what you skipped" and every other rule Claude Code would have carried are gone unless OpenBot sends
them. `fixtures/server-instructions.json` is what the server sends a Claude SDK Bot on a routine, kept
byte for byte by the server's own test (`server/tests/copilot.test.ts`, "a Claude Agent SDK Bot on a
routine"); this runs it through the adapter and reads the prompt Claude Code is started with.

No provider requests, credentials, or Claude subprocesses: a controlled SDK client records what the
query was given.
"""

import asyncio
import json
import re
import sys
from pathlib import Path

import claude_agent_sdk
import pytest
from ag_ui.core import RunAgentInput
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter
from test_tool_continuation import started_with

FIXTURE = Path(__file__).parent / "fixtures" / "server-instructions.json"


def section(prompt, tag):
    found = re.search(rf"^<{tag}>\n(.*?)\n</{tag}>$", prompt, re.MULTILINE | re.DOTALL)
    return found.group(1) if found else None


@pytest.fixture
def sdk(monkeypatch):
    clients = []

    class Client:
        def __init__(self, options):
            self.options = options
            self.system_prompt = None
            clients.append(self)

        async def connect(self):
            # Claude Code reads its system prompt when it starts, from the file it is given.
            self.system_prompt = started_with(self.options)

        async def disconnect(self):
            pass

        async def interrupt(self):
            pass

        async def query(self, prompt, session_id):
            if not isinstance(prompt, str):
                async for _ in prompt:
                    pass

        async def receive_response(self):
            yield AssistantMessage(content=[TextBlock(text="ok")], model="controlled-sdk")
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="thread-cycle-plan",
            )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)
    return clients


def test_a_routine_starts_claude_code_with_openbots_working_rules(sdk):
    sent = json.loads(FIXTURE.read_text(encoding="utf-8"))["messages"]
    role = sent[0]["content"]
    request = RunAgentInput.model_validate(
        {
            "threadId": "thread-cycle-plan",
            "runId": "run-1",
            "state": {},
            "messages": [
                *sent,
                {
                    "id": "firing",
                    "role": "user",
                    "content": "Plan next cycle from the candidates page.",
                },
            ],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
    )

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:
            async with asyncio.timeout(2):
                finished = [event async for event in adapter.run(request)]
            assert finished[-1].type == "RUN_FINISHED"
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
    system_prompt = sdk[-1].system_prompt

    # How to work, when to ask, and that nobody is watching: each section as the server wrote it.
    for tag in ("how_to_work", "asking", "run_mode", "sources", "untrusted_content"):
        written = section(role, tag)
        assert written, f"the server sent no <{tag}> section"
        assert section(system_prompt, tag) == written, f"<{tag}> did not reach Claude Code"
    assert "take it in the same reply instead of saying you will" in system_prompt
    assert "Nobody is watching this run" in system_prompt
    assert "What I could not confirm" in system_prompt
    # Told OpenBot asks before what it gives the Bot, so the Bot does not ask a second time.
    assert "When you use the apps and tools OpenBot gives you, OpenBot asks" in system_prompt
    # The server's instructions are the whole prompt, first: Claude Code's own is not added.
    assert system_prompt.startswith("<identity>\nYou are Risk")
