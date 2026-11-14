"""A browser that leaves mid-reply stops the Claude Code process it started.

`ag-ui-claude-sdk` streams a run through Starlette's `StreamingResponse`. When the browser goes
away (Stop, a reload, another screen, or the OpenBot server dropping the call), Starlette cancels
the response's anyio cancel scope, and anyio delivers that cancellation again at every await in
the task. `run`'s cleanup used to be one of those awaits: it was cancelled at its first step, so
the query was never interrupted, its SDK worker never stopped, and its `claude` process ran on with
nobody listening. Each one holds a couple of hundred megabytes and keeps a CPU busy, so a machine
that had been used for a few hours ran out of both.

No provider requests, credentials, or Claude subprocesses: the SDK client is a stand-in that
replies until it is interrupted, as Claude Code does.
"""

import asyncio
import sys
from pathlib import Path

import anyio
import claude_agent_sdk
import pytest
from ag_ui.core import RunAgentInput
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter


def request(thread="thread-a"):
    return RunAgentInput.model_validate(
        {
            "threadId": thread,
            "runId": "run-1",
            "state": {},
            "messages": [{"id": "user-1", "role": "user", "content": "Plan my day"}],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
    )


@pytest.fixture
def sdk(monkeypatch):
    clients = []

    class Client:
        """Replies until interrupted, then finishes its turn."""

        def __init__(self, options):
            self.options = options
            self.replying = asyncio.Event()
            self.interrupted = asyncio.Event()
            self.disconnected = asyncio.Event()
            clients.append(self)

        async def connect(self):
            pass

        async def disconnect(self):
            self.disconnected.set()

        async def interrupt(self):
            # A real interrupt is a control request written to the CLI and answered by it: work
            # that takes a turn of the event loop, where a cancelled task is cancelled again.
            await asyncio.sleep(0)
            self.interrupted.set()

        async def query(self, prompt, session_id):
            if not isinstance(prompt, str):
                [message async for message in prompt]

        async def receive_response(self):
            yield AssistantMessage(content=[TextBlock(text="Working on it.")], model="controlled-sdk")
            self.replying.set()
            await self.interrupted.wait()
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


def test_browser_leaving_mid_reply_stops_the_claude_process(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        try:

            async def stream():
                async for _ in adapter.run(request()):
                    pass

            # What Starlette's StreamingResponse does: the response runs in a task group, and the
            # group is cancelled when the browser disconnects.
            async with anyio.create_task_group() as response:
                response.start_soon(stream)
                async with asyncio.timeout(2):
                    while not sdk or not sdk[0].replying.is_set():
                        await asyncio.sleep(0.01)
                response.cancel_scope.cancel()

            client = sdk[0]
            async with asyncio.timeout(2):
                await client.interrupted.wait()
                await client.disconnected.wait()
            assert "thread-a" not in adapter._turns
            assert "thread-a" not in adapter._workers
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
