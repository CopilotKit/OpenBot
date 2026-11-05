"""A fresh Antigravity process answers from the whole thread the server sent, in the Bot's role.

See `shared/harness_contract.py` for what the contract is and why it is checked at the model.

The model is not called from Python here. `ag_ui_antigravity` drives the Go `localharness` the SDK
wheel bundles, and it is that binary which builds the request and sends it to the Gemini API. So
the check runs the real binary, pointed by `GOOGLE_GENERATIVE_AI_BASE_URL` at a fake Gemini on
localhost, and reads the body the harness posts to `:streamGenerateContent`. `fake_provider()`
speaks OpenAI and Anthropic only, so the Gemini stand-in lives here. Nothing this Bot or the
integration does in Python can make the check pass unless the harness really sent the text on.
"""

import importlib
import json
import socket
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import (
    EARLIER_QUESTION,
    LATEST_QUESTION,
    STANDING_ROLE,
    conversation,
    missing_from,
    run_events,
)

TOKEN = "contract-token"
NEXT_QUESTION = "CONTRACT_NEXT_QUESTION_7f3a"
CHANGED_ROLE = "CONTRACT_CHANGED_ROLE_7f3a"


@contextmanager
def fake_gemini():
    """A Gemini API on localhost that answers "ok" and records every generate request body."""
    import uvicorn
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, StreamingResponse

    bodies: list[dict] = []
    app = FastAPI()
    answer = {
        "candidates": [
            {
                "content": {"role": "model", "parts": [{"text": "ok"}]},
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
    }

    @app.post("/v1beta/models/{call}")
    async def generate(call: str, request: Request):
        bodies.append(await request.json())
        if call.endswith(":streamGenerateContent"):

            async def stream():
                yield f"data: {json.dumps(answer)}\r\n\r\n"

            return StreamingResponse(stream(), media_type="text/event-stream")
        return JSONResponse(answer)

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    try:
        yield f"http://127.0.0.1:{port}", bodies
    finally:
        server.should_exit = True
        thread.join(timeout=10)


@contextmanager
def fresh_bot(monkeypatch, tmp_path):
    """A newly imported app, as a restarted container has, on its own harness and home."""
    with fake_gemini() as (base, bodies):
        # The harness keeps its app data under $HOME; a test must not read or leave any there.
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
        monkeypatch.setenv("GOOGLE_API_KEY", "contract-key")
        monkeypatch.setenv("GOOGLE_GENERATIVE_AI_BASE_URL", base)
        monkeypatch.delenv("BOT_PROVIDER", raising=False)
        monkeypatch.delenv("BOT_MODEL", raising=False)
        from src import main

        main = importlib.reload(main)
        with TestClient(main.app) as client:

            def run(body):
                before = len(bodies)
                response = client.post("/", json=body, headers={"x-openbot-agent-token": TOKEN})
                assert response.status_code == 200
                assert [
                    e["type"] for e in run_events(response.text) if e["type"].startswith("RUN_")
                ] == ["RUN_STARTED", "RUN_FINISHED"], response.text
                assert len(bodies) > before, "the model was never called"
                return bodies[-1]

            yield run


def _system_instruction(body: dict) -> str:
    return json.dumps(body.get("systemInstruction", {}))


def _next_turn(run: dict, *, role: str | None = None) -> dict:
    """The same thread one turn later, the way the server sends it: everything again, plus more."""
    following = json.loads(json.dumps(run))
    following["runId"] = "contract-run-2"
    if role is not None:
        following["messages"][0]["content"] = f"You are Contract Bot. {role}"
    following["messages"] += [
        {"id": "a2", "role": "assistant", "content": "ok"},
        {"id": "u3", "role": "user", "content": f"And after that? {NEXT_QUESTION}"},
    ]
    return following


def test_a_fresh_process_answers_from_the_whole_thread_in_its_role(monkeypatch, tmp_path):
    with fresh_bot(monkeypatch, tmp_path) as run:
        body = run(conversation())
    assert missing_from(body) == []
    assert STANDING_ROLE in _system_instruction(body), "the standing role is a system instruction"


def test_a_live_session_is_not_sent_the_history_twice(monkeypatch, tmp_path):
    first = conversation()
    with fresh_bot(monkeypatch, tmp_path) as run:
        run(first)
        body = run(_next_turn(first))
    assert missing_from(body) == []
    sent = json.dumps(body)
    assert NEXT_QUESTION in sent
    assert sent.count(EARLIER_QUESTION) == 1, sent
    assert sent.count(LATEST_QUESTION) == 1, sent


def test_a_changed_standing_role_reaches_the_next_run(monkeypatch, tmp_path):
    first = conversation()
    with fresh_bot(monkeypatch, tmp_path) as run:
        run(first)
        body = run(_next_turn(first, role=CHANGED_ROLE))
    assert CHANGED_ROLE in _system_instruction(body)
    assert STANDING_ROLE not in json.dumps(body)
    sent = json.dumps(body)
    for marker in (EARLIER_QUESTION, LATEST_QUESTION, NEXT_QUESTION):
        assert sent.count(marker) == 1, (marker, sent)


PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def test_an_earlier_tool_call_and_an_attached_image_are_part_of_the_thread(monkeypatch, tmp_path):
    run = conversation()
    run["messages"][2:2] = [
        {
            "id": "u0",
            "role": "user",
            "content": [
                {"type": "text", "text": "Look at this"},
                {"type": "image", "source": {"type": "data", "mimeType": "image/png", "value": PIXEL}},
            ],
        },
        {
            "id": "a0",
            "role": "assistant",
            "content": "",
            "toolCalls": [
                {"id": "call-0", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}
            ],
        },
        {"id": "t0", "role": "tool", "toolCallId": "call-0", "content": "TOOL_RESULT_MARKER"},
    ]
    with fresh_bot(monkeypatch, tmp_path) as send:
        body = send(run)
    assert missing_from(body) == []
    sent = json.dumps(body)
    assert "TOOL_RESULT_MARKER" in sent
    assert "call-0" in sent
    assert PIXEL in sent, "the image attached earlier in the thread reached the model"
