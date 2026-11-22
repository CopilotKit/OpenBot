"""Once a run is over, the Claude Code process its query started is gone.

FOUND IN DOGFOODING. A Claude plan's agent container held 55 Claude Code processes
(`claude_agent_sdk/_bundled/claude`), 35 of them more than a day old, about 0.1 GiB each. The
Docker VM ran out of memory and swap, and OpenBot stopped. Restarting only the agent container gave
back 11 GB. Its log had `SDK MCP server 'ag_ui' did not stop within 5.0s of being closed`.

Each query is ended by `SessionWorker.stop()`, which closes the SDK client: the SDK stops the
in-process MCP servers (giving a stuck tool 5 seconds), closes Claude Code's stdin, then waits,
terminates and kills it. That close only finishes when no asyncio cancellation reaches it. The
query was ended from inside the run's own task, so a second cancellation of that task (a second
stop, the person's next message, a run whose request closed) arrived in the middle of it. The SDK
gave up before it closed stdin or sent a signal, and nothing tried again. Claude Code, still waiting
on its tool call with stdin open, waited for ever. A run whose request closed did not end its query
at all: the cleanup stopped at its first await.

These run the real Claude Code this harness ships, through the harness's own routes, against a
local stand-in for the Messages API, and count the Claude Code processes this test process started.
"""

import asyncio
import dataclasses
import importlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import anyio
import claude_agent_sdk
import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "valid-test-token"
CLI = os.path.realpath(Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude")
# Asks the stand-in API to call the run's first tool.
CALL_A_TOOL = "Show me the card."
# Asks the stand-in API to hold its answer until the test ends: a model still working.
TAKE_YOUR_TIME = "Think about it for a long while."
# The longest a run's end may take to remove its process: the SDK's own close (5 seconds for a stuck
# tool's MCP server, 5 for Claude Code to exit after stdin closes), with room for a loaded machine.
GONE_WITHIN = 25


def _children():
    """This test process's child processes, as (pid, executable or command line)."""
    if os.path.isdir("/proc"):
        # Linux. Claude Code sets its process title there, which rewrites the command line `ps`
        # shows, so each child is known by the executable it runs.
        found = []
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(f"/proc/{entry}/stat", encoding="utf-8") as stat:
                    ppid = int(stat.read().rsplit(")", 1)[1].split()[1])
                if ppid == os.getpid():
                    found.append((int(entry), os.path.realpath(f"/proc/{entry}/exe")))
            except (OSError, IndexError, ValueError):
                continue  # Gone while it was being read.
        return found
    listing = subprocess.run(
        ["ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "command="],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    found = []
    for line in listing.splitlines():
        pid, ppid, command = line.strip().split(None, 2)
        if int(ppid) == os.getpid():
            found.append((int(pid), command))
    return found


def claude_processes():
    """The Claude Code processes this test process started that are still running."""
    return [pid for pid, program in _children() if program.startswith(CLI)]


async def left_after(seconds=GONE_WITHIN):
    """The Claude Code processes still running once `seconds` have passed, or none sooner."""
    deadline = time.monotonic() + seconds
    while (left := claude_processes()) and time.monotonic() < deadline:
        await asyncio.sleep(0.25)
    return left


def _events(lines):
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in lines)


def _reply(model, block, stop_reason):
    if block["type"] == "text":
        content = [
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": block["text"]}},
        ]
    else:
        content = [
            {"type": "content_block_start", "index": 0, "content_block": {**block, "input": {}}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{}"}},
        ]
    return [
        {
            "type": "message_start",
            "message": {
                "id": "msg_card",
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 1},
            },
        },
        *content,
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {"output_tokens": 5}},
        {"type": "message_stop"},
    ]


@pytest.fixture
def released():
    """Set when the test ends, to let go of everything the stand-ins are holding."""
    event = threading.Event()
    yield event
    event.set()


@pytest.fixture
def messages_api(released):
    """A local Messages API: calls the offered tool when asked to, holds when asked to, else answers."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            if not self.path.startswith("/v1/messages") or "count_tokens" in self.path:
                self.send_response(404)
                self.end_headers()
                return
            asked = json.dumps(body.get("messages"))
            tools = [tool["name"] for tool in body.get("tools", []) if tool["name"].startswith("mcp__ag_ui__")]
            if TAKE_YOUR_TIME in asked:
                released.wait(120)
            if tools and CALL_A_TOOL in asked and "tool_result" not in asked:
                block, stop = {"type": "tool_use", "id": f"toolu_{time.monotonic_ns()}", "name": tools[0]}, "tool_use"
            else:
                block, stop = {"type": "text", "text": "Here it is."}, "end_turn"
            payload = _events(_reply(body.get("model", "claude-test"), block, stop)).encode()
            try:
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Claude Code was ended while this answer was on its way.

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def harness(monkeypatch, tmp_path, messages_api):
    # Claude Code itself, on a key, against the local API, with its own home and no retries.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", messages_api)
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.setenv("CLAUDE_CODE_MAX_RETRIES", "0")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    from src import main

    yield importlib.reload(main)
    # Whatever a failing test left behind is not left for the next one.
    for pid in claude_processes():
        os.kill(pid, signal.SIGKILL)


@pytest.fixture
def stuck_tool(monkeypatch, released):
    """Every tool of the `ag_ui` MCP server blocks in a worker thread until the test ends.

    A tool blocked outside the event loop does not react to cancellation, so the SDK's MCP server
    does not stop within its 5 seconds: the `did not stop within 5.0s` line in the field's log.
    """
    from src import adapter

    convert = adapter.convert_agui_tool_to_claude_sdk
    called = threading.Event()

    def blocked(tool):
        converted = convert(tool)

        async def handler(arguments):
            called.set()
            await anyio.to_thread.run_sync(released.wait, 120)
            return {"content": [{"type": "text", "text": "Shown."}]}

        return dataclasses.replace(converted, handler=handler)

    monkeypatch.setattr(adapter, "convert_agui_tool_to_claude_sdk", blocked)
    return called


def run_input(thread, run, text, tools=(), results=()):
    messages = [{"id": f"{run}-user", "role": "user", "content": text}]
    for call in results:
        messages += [
            {
                "id": f"{run}-call",
                "role": "assistant",
                "content": "",
                "toolCalls": [{"id": call, "type": "function", "function": {"name": "showCard", "arguments": "{}"}}],
            },
            {"id": f"{run}-result", "role": "tool", "toolCallId": call, "content": "The card is on screen."},
        ]
    return {
        "threadId": thread,
        "runId": run,
        "state": None,
        "messages": messages,
        "tools": [
            {"name": name, "description": "Show a card.", "parameters": {"type": "object", "properties": {}}}
            for name in tools
        ],
        "context": [],
        "forwardedProps": {},
    }


def client_for(harness):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=harness.app), base_url="http://harness", timeout=120
    )


async def events(client, path, body):
    response = await client.post(
        path, headers={"x-openbot-agent-token": TOKEN, "accept": "text/event-stream"}, json=body
    )
    assert response.status_code == 200
    return [json.loads(line.removeprefix("data: ")) for line in response.text.splitlines() if line.startswith("data: ")]


async def started(path, client, body):
    """The run's request, once its Claude Code is running; the caller closes it."""
    request = asyncio.create_task(events(client, path, body))
    deadline = time.monotonic() + 30
    while not claude_processes():
        assert time.monotonic() < deadline, f"Claude Code never started; children: {_children()}"
        assert not request.done(), "the run ended before it could be closed"
        await asyncio.sleep(0.05)
    # Past Claude Code's start, into the model call the stand-in holds.
    await asyncio.sleep(1)
    return request


@pytest.mark.parametrize("path", ["/model", "/"])
def test_no_claude_is_left_after_runs_that_finish_or_whose_request_closes(harness, path):
    async def scenario():
        async with client_for(harness) as client:
            finished = await events(client, path, run_input("thread-answer", "run-answer", "Hello."))
            assert finished[-1]["type"] == "RUN_FINISHED"
            assert await left_after() == []

            # A step that hands a call to the browser, and the run that brings its result.
            step = await events(client, path, run_input("thread-card", "run-card", CALL_A_TOOL, tools=["showCard"]))
            assert step[-1]["type"] == "RUN_FINISHED"
            calls = [event["toolCallId"] for event in step if event["type"] == "TOOL_CALL_START"]
            assert calls
            resumed = await events(
                client, path, run_input("thread-card", "run-card-2", CALL_A_TOOL, tools=["showCard"], results=calls)
            )
            assert resumed[-1]["type"] == "RUN_FINISHED"
            assert await left_after() == []

            # The person leaves while the model is still working: the run's request closes.
            request = await started(path, client, run_input("thread-gone", "run-gone", TAKE_YOUR_TIME))
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert await left_after() == [], "the closed run's Claude Code is still running"

    asyncio.run(scenario())


def test_no_claude_is_left_when_its_tool_does_not_stop(harness, stuck_tool, caplog):
    """The field's case: a query whose tool is stuck, ended twice while its SDK client is closing."""

    async def scenario():
        async with client_for(harness) as client:
            body = run_input("thread-stuck", "run-stuck", CALL_A_TOOL, tools=["showCard"])
            request = asyncio.create_task(events(client, "/model", body))

            async def stop():
                response = await client.post(
                    "/model/cancel", headers={"x-openbot-agent-token": TOKEN}, json={"threadId": "thread-stuck"}
                )
                assert response.status_code == 200

            deadline = time.monotonic() + 30
            while not stuck_tool.is_set():
                assert time.monotonic() < deadline, "the tool was never called"
                assert not request.done(), "the run ended before its tool was called"
                await asyncio.sleep(0.05)
            # Stopped, and stopped again while the first stop is still closing the query.
            first = asyncio.create_task(stop())
            await asyncio.sleep(1)
            second = asyncio.create_task(stop())
            await asyncio.gather(first, second)
            await asyncio.gather(request, return_exceptions=True)
            assert await left_after() == [], "Claude Code outlived its query"
        # The SDK's MCP server really did overrun its 5 seconds before Claude Code was gone.
        assert "SDK MCP server 'ag_ui' did not stop within 5.0s" in caplog.text

    asyncio.run(scenario())
