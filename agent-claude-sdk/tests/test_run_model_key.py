"""Claude Code calls OpenBot's model gateway with the token of the run, in its organization.

One harness serves every organization of an OpenBot, and the key in its environment is the
deployment's gateway token, which names one organization. The server sends each run a token of its
own (`openbotModelRoute`). Claude Code makes the model calls from a process of its own, so a query
on the gateway sends them back through this harness, which passes each on with the newest token a
run of that thread brought (`src/run_model_proxy.py`). A run with no token, and an address that is
not the gateway's, are given what they always were.

These run the real Claude Code this harness ships, through the harness's own routes on a real port
(Claude Code dials it), against a local stand-in for the gateway's Anthropic wire.
"""

import importlib
import json
import socket
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import (
    DEPLOYMENT_KEY,
    RUN_KEY,
    fake_provider,
    gateway_environment,
    run_events,
)

TOKEN = "valid-test-token"
LATER_KEY = "obgw_contract-later-run-token"


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _serve(app, port):
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    return server, thread


def _run(port, thread, key=None):
    props = {"openbotSendOnce": True}
    if key:
        props["openbotModelRoute"] = {"via": "anthropic", "token": key}
        props["openbotOrganization"] = "contract-organization"
    response = httpx.post(
        f"http://127.0.0.1:{port}/",
        headers={"x-openbot-agent-token": TOKEN, "accept": "text/event-stream"},
        json={
            "threadId": thread,
            "runId": f"run-{time.monotonic_ns()}",
            "state": {},
            "messages": [{"id": f"user-{time.monotonic_ns()}", "role": "user", "content": "Hello?"}],
            "tools": [],
            "context": [],
            "forwardedProps": props,
        },
        timeout=120,
    )
    assert response.status_code == 200
    events = run_events(response.text)
    assert events[-1]["type"] == "RUN_FINISHED", events
    return events


@pytest.fixture
def harness(monkeypatch, tmp_path):
    keys: list[str] = []
    with fake_provider(keys) as (base, bodies):
        for name, value in gateway_environment("anthropic")(base).items():
            monkeypatch.setenv(name, value)
        monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
        monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
        port = _free_port()
        monkeypatch.setenv("PORT", str(port))
        from src import main

        server, thread = _serve(importlib.reload(main).app, port)
        try:
            yield port, keys, bodies
        finally:
            server.should_exit = True
            thread.join(timeout=10)


def _messages_keys(keys, start):
    """The keys the Messages API calls presented since `start` (Claude Code also asks other routes)."""
    return [key for key in keys[start:] if key]


def test_claude_code_calls_the_gateway_with_the_runs_own_key(harness):
    port, keys, bodies = harness

    _run(port, "thread-org-b", RUN_KEY)
    with_token = _messages_keys(keys, 0)
    assert with_token and set(with_token) == {RUN_KEY}, keys

    # The next run of the thread brings a newer token; the thread's calls carry that from now.
    start = len(keys)
    _run(port, "thread-org-b", LATER_KEY)
    later = _messages_keys(keys, start)
    assert later and set(later) == {LATER_KEY}, keys

    # A run with no token: the environment's key, straight to the gateway, as before.
    start = len(keys)
    _run(port, "thread-without-token")
    without = _messages_keys(keys, start)
    assert without and set(without) == {DEPLOYMENT_KEY}, keys

    # Neither the token nor the organization is ever said to the model.
    text = json.dumps(bodies)
    assert RUN_KEY not in text and LATER_KEY not in text and "contract-organization" not in text


def test_the_way_back_in_takes_nothing_it_does_not_know(harness):
    port, keys, _ = harness
    # No secret this process handed out, so nothing is passed on and no key is spent.
    response = httpx.post(
        f"http://127.0.0.1:{port}/_run-model/made-up-secret/v1/messages",
        json={"model": "claude-sonnet-5-5", "messages": []},
        timeout=30,
    )
    assert response.status_code == 404
    assert keys == []
