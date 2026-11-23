"""A model address with nothing answering at it is told as that, never as a refusal.

FOUND ON OPENBOT DESKTOP, on the LangGraph harness: a base URL at host.docker.internal:48123 with
nothing listening, and the person read only "The Bot stopped before it finished answering. Try
again." Claude Code meets the same address with an error message of its own, "API Error: Connection
refused — a firewall or proxy may be blocking it (ConnectionRefused)", which this harness passed on
as a provider's refusal and the server told as "Anthropic turned down the request". Nobody turned
anything down: nothing answered.

These run the real Claude Code this harness ships, through the harness's own routes, against a
loopback port with nothing listening and a host that never resolves.
"""

import asyncio
import importlib
import json
import socket
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "valid-test-token"
NEXT_STEP = "Check that it's running and the address is right."


def closed_port():
    """A loopback port with nothing listening on it."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def app(monkeypatch, tmp_path, base_url):
    # Claude Code itself, on a key, against an address nothing answers at, with its own home.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", base_url)
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    from src import main

    return importlib.reload(main).app


def run(app, path, body):
    async def send():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://harness", timeout=120
        ) as client:
            return await client.post(
                path,
                headers={"x-openbot-agent-token": TOKEN, "accept": "text/event-stream"},
                json=body,
            )

    response = asyncio.run(send())
    assert response.status_code == 200
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def ask(forwarded_props):
    return {
        "threadId": "thread-unreachable",
        "runId": "run-unreachable",
        "state": {},
        "messages": [{"id": "user-1", "role": "user", "content": "Hello?"}],
        "tools": [],
        "context": [],
        # Sent once: Claude Code's own ten retries would only make the test wait for the same end.
        "forwardedProps": {**forwarded_props, "openbotSendOnce": True},
    }


ROUTES = [
    # A Claude Agent SDK Bot, on the harness's own route.
    ("/", {}),
    # A built-in Bot on a Claude plan: the server asks the plan's model through here.
    ("/model", {"openbotModelOnly": True, "openbotBotId": "personal-assistant"}),
]


@pytest.mark.parametrize("path,props", ROUTES)
def test_a_model_address_with_nothing_listening_is_told_as_unreachable(
    monkeypatch, tmp_path, path, props
):
    port = closed_port()
    events = run(app(monkeypatch, tmp_path, f"http://127.0.0.1:{port}"), path, ask(props))
    assert events[-1]["type"] == "RUN_ERROR", [event["type"] for event in events]
    # Coded, so the server says it with the step that fits its edition.
    assert events[-1]["code"] == "OPENBOT_MODEL_UNREACHABLE"
    assert events[-1]["message"] == (
        f"OpenBot couldn't reach the AI model at 127.0.0.1:{port}. {NEXT_STEP}"
    )
    # Claude Code's own account is never the Bot's answer.
    assert not [event for event in events if event["type"] == "TEXT_MESSAGE_CONTENT"]


def test_a_model_host_that_does_not_exist_is_told_the_same_way(monkeypatch, tmp_path):
    # `.invalid` never resolves (RFC 2606), so this is a DNS failure and never leaves the machine.
    # The address is host and port only: never the credentials a URL can carry.
    base = "http://synthetic-user:synthetic-secret@openbot-model.invalid:48123"
    events = run(app(monkeypatch, tmp_path, base), "/", ask({}))
    assert events[-1]["type"] == "RUN_ERROR", [event["type"] for event in events]
    assert events[-1]["code"] == "OPENBOT_MODEL_UNREACHABLE"
    assert events[-1]["message"] == (
        f"OpenBot couldn't reach the AI model at openbot-model.invalid:48123. {NEXT_STEP}"
    )
    assert "synthetic-secret" not in json.dumps(events)
