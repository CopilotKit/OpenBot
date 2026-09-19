import importlib
import json
import socket
import sys
import threading
import time
from pathlib import Path

import httpx2
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "test-token"
RUN = {
    "threadId": "thread-1",
    "runId": "run-1",
    "state": {},
    "messages": [{"id": "m1", "role": "user", "content": "Say hello"}],
    "tools": [],
    "context": [],
    "forwardedProps": {},
}


def _sse(events):
    async def stream():
        for event in events:
            yield event

    return StreamingResponse(stream(), media_type="text/event-stream")


def _provider_app(seen):
    app = FastAPI()

    @app.post("/v1/chat/completions")
    async def openai_chat(request: Request):
        body = await request.json()
        seen.append(("openai", body["model"]))
        if not body.get("stream"):
            return JSONResponse(
                {
                    "id": "c",
                    "object": "chat.completion",
                    "created": 0,
                    "model": body["model"],
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": "hello"},
                        }
                    ],
                }
            )
        chunk = {
            "id": "c",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": body["model"],
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": "hello"},
                    "finish_reason": None,
                }
            ],
        }
        done = {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
        return _sse(
            [f"data: {json.dumps(chunk)}\n\n", f"data: {json.dumps(done)}\n\n", "data: [DONE]\n\n"]
        )

    @app.post("/v1/messages")
    async def anthropic_messages(request: Request):
        body = await request.json()
        seen.append(("anthropic", body["model"]))
        message = {
            "id": "msg",
            "type": "message",
            "role": "assistant",
            "model": body["model"],
            "stop_sequence": None,
        }
        if not body.get("stream"):
            return JSONResponse(
                {
                    **message,
                    "content": [{"type": "text", "text": "hello"}],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                }
            )
        events = [
            ("message_start", {"type": "message_start", "message": {**message, "content": [], "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hello"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        return _sse([f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events])

    return app


@pytest.fixture
def provider():
    seen = []
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(_provider_app(seen), host="127.0.0.1", port=port, log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    yield f"http://127.0.0.1:{port}", seen
    server.should_exit = True
    thread.join(timeout=10)


CHOICES = {
    "an Anthropic key": (
        lambda base: {
            "BOT_PROVIDER": "anthropic",
            "BOT_MODEL": "claude-sonnet-4-5",
            "ANTHROPIC_API_KEY": "test-key",
            "ANTHROPIC_BASE_URL": base,
            "OPENAI_API_KEY": "",
            "OPENAI_BASE_URL": "",
        },
        ("anthropic", "claude-sonnet-4-5"),
    ),
    "an OpenAI-compatible endpoint": (
        lambda base: {
            "BOT_PROVIDER": "",
            "BOT_MODEL": "local-model",
            "OPENAI_API_KEY": "no-key-needed",
            "OPENAI_BASE_URL": f"{base}/v1",
            "ANTHROPIC_API_KEY": "",
        },
        ("openai", "local-model"),
    ),
    "an OpenAI key": (
        lambda base: {
            "BOT_PROVIDER": "",
            "BOT_MODEL": "gpt-5.5",
            "OPENAI_API_KEY": "test-key",
            "OPENAI_BASE_URL": f"{base}/v1",
            "ANTHROPIC_API_KEY": "",
        },
        ("openai", "gpt-5.5"),
    ),
}


@pytest.mark.parametrize("choice", list(CHOICES))
def test_a_run_reaches_the_model_the_setup_screen_chose(monkeypatch, provider, choice):
    base, seen = provider
    environment, expected = CHOICES[choice]
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    for key, value in environment(base).items():
        monkeypatch.setenv(key, value)

    from src import main

    main = importlib.reload(main)
    response = TestClient(main.app).post(
        "/", json=RUN, headers={"x-openbot-agent-token": TOKEN}
    )

    assert response.status_code == 200
    assert '"RUN_FINISHED"' in response.text
    assert '"RUN_ERROR"' not in response.text
    assert seen == [expected]


def test_an_anthropic_key_uses_the_official_endpoint_when_compose_sets_a_blank_url(monkeypatch):
    seen = []

    async def respond(transport, request):
        body = json.loads(request.content)
        seen.append((str(request.url), request.headers.get("x-api-key"), body["model"]))
        return httpx2.Response(
            200,
            request=request,
            json={
                "id": "msg",
                "type": "message",
                "role": "assistant",
                "model": body["model"],
                "content": [{"type": "text", "text": "hello"}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        )

    # Keep the real AG2 and Anthropic clients; replace only the network transport.
    monkeypatch.setattr(httpx2.AsyncHTTPTransport, "handle_async_request", respond)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("BOT_PROVIDER", "anthropic")
    monkeypatch.setenv("BOT_MODEL", "claude-sonnet-4-5")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)

    from src import main

    main = importlib.reload(main)
    response = TestClient(main.app).post(
        "/", json=RUN, headers={"x-openbot-agent-token": TOKEN}
    )

    assert seen == [("https://api.anthropic.com/v1/messages", "test-key", "claude-sonnet-4-5")]
    assert response.status_code == 200
    assert '"RUN_FINISHED"' in response.text
    assert '"RUN_ERROR"' not in response.text
    assert "hello" in response.text
