"""A message that starts with a skill's command is answered by the model, not by Claude Code.

FOUND ON WINDOWS. On a Claude plan, a person picked their "Tide report" skill from the `/` menu of the
built-in Personal Assistant and wrote "lighthouses". The Bot answered "Unknown command:
/tide-report" at once. The skill's instructions were in the system prompt; the model never saw them,
because the model was never asked.

Claude Code reads the last text block of the prompt it is sent as what was typed at its own prompt,
and one that starts with `/` as one of its own slash commands. It holds no command of that name, so
it answers "Unknown command" itself. The replay sends each part of a message that arrived as parts
(the server's model endpoint sent every user message that way) as a block of its own, so the
person's own words, starting with the command, were that last block. The server now sends words as
one string; these hold the harness to it for any message that still arrives as parts.

These run the real Claude Code this harness ships, through the harness's own routes, against a
local stand-in for the Messages API that records what the model is asked.
"""

import asyncio
import importlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "valid-test-token"
REPLY = "High water at the lighthouse is at 06:12."
SKILL = "Answer with the tide times for the place named, as a table."
# What the server writes for a picked skill (`pickedSkillGuidance` in server/src/plugins/picked-skill.ts).
GUIDANCE = (
    'The person picked the skill "Tide report" (/tide-report) for their latest message. '
    f"Follow its instructions for this reply:\n\n{SKILL}"
)


def _events(lines):
    """One streamed Messages API reply, as the API sends it."""
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in lines)


def _reply(model):
    return [
        {
            "type": "message_start",
            "message": {
                "id": "msg_tide",
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 1},
            },
        },
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": REPLY}},
        {"type": "content_block_stop", "index": 0},
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 12},
        },
        {"type": "message_stop"},
    ]


@pytest.fixture
def messages_api():
    """A local Messages API that answers every request with `REPLY` and keeps what it was sent."""
    asked = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            if not self.path.startswith("/v1/messages") or "count_tokens" in self.path:
                self.send_response(404)
                self.end_headers()
                return
            asked.append(body)
            model = body.get("model", "claude-test")
            if body.get("stream"):
                payload = _events(_reply(model)).encode()
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
            else:
                message = {**_reply(model)[0]["message"], "content": [{"type": "text", "text": REPLY}]}
                payload = json.dumps({**message, "stop_reason": "end_turn"}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", asked
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def app(monkeypatch, tmp_path, messages_api):
    url, _ = messages_api
    # Claude Code itself, on a key, against the local API, with its own home and no retries.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", url)
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.setenv("CLAUDE_CODE_MAX_RETRIES", "0")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    from src import main

    return importlib.reload(main).app


def _run(app, path, body):
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
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    errors = [event for event in events if event["type"] == "RUN_ERROR"]
    assert errors == []
    return "".join(event["delta"] for event in events if event["type"] == "TEXT_MESSAGE_CONTENT")


def _asked_with(asked, instruction):
    """The request that carried the Bot's own instructions: the one the run asked the model."""
    found = [body for body in asked if instruction in json.dumps(body.get("system"))]
    assert found, "the model was never asked with the Bot's instructions"
    return found[-1]


def test_a_built_in_bot_on_a_claude_plan_is_answered_by_the_model(app, messages_api):
    """The request the server's plan model sends (`PlanModel.doStream` in server/src/agents/plan-model.ts)."""
    _, asked = messages_api
    answer = _run(
        app,
        "/model",
        {
            "threadId": "a" * 64,
            "runId": "run-tide",
            "state": None,
            # As `planMessages` sent every user message before it sent words as one string.
            "messages": [
                {"id": "prompt-1", "role": "user", "content": [{"type": "text", "text": "/tide-report lighthouses"}]}
            ],
            "tools": [],
            "context": [
                {
                    "description": "Built-in Bot instructions",
                    "value": f"You are Personal Assistant.\n\n{GUIDANCE}",
                }
            ],
            "forwardedProps": {"openbotModelOnly": True, "openbotBotId": "personal-assistant"},
        },
    )
    assert "Unknown command" not in answer
    assert answer == REPLY
    request = _asked_with(asked, SKILL)
    # The person's words reach the model, command and all.
    assert "/tide-report lighthouses" in json.dumps(request["messages"])


def test_a_claude_agent_sdk_bot_given_parts_is_answered_by_the_model(app, messages_api):
    """A Claude Agent SDK Bot sent the person's message as parts, on the harness's own route."""
    _, asked = messages_api
    answer = _run(
        app,
        "/",
        {
            "threadId": "thread-tide",
            "runId": "run-tide",
            "state": {},
            "messages": [
                # The standing role the server sends a remote Bot, the picked skill at its end
                # (`remoteAgentWithStandingRole` in server/src/copilot.ts).
                {"id": "standing-role:claude-sdk", "role": "system", "content": f"You are Claude Agent SDK.\n\n{GUIDANCE}"},
                {"id": "user-1", "role": "user", "content": [{"type": "text", "text": "/tide-report lighthouses"}]},
            ],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        },
    )
    assert "Unknown command" not in answer
    assert answer == REPLY
    request = _asked_with(asked, SKILL)
    assert "/tide-report lighthouses" in json.dumps(request["messages"])
