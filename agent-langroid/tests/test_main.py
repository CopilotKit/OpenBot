import importlib
import json
import socket
import sys
import threading
import time
from pathlib import Path

import httpx
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


def test_an_openai_key_uses_the_official_endpoint_when_compose_sets_a_blank_url(monkeypatch, provider):
    # The "an OpenAI key" choice above points OPENAI_BASE_URL at the fake provider, which is how the
    # empty value Compose actually writes for a plain OpenAI key went untested: the OpenAI SDK only
    # defaults an absent URL, so "" left every request without a host.
    base, provider_seen = provider
    port = int(base.rsplit(":", 1)[1])
    destinations = []

    def reroute(transport_class, method_name):
        original = getattr(transport_class, method_name)

        if method_name.startswith("handle_async"):

            async def forward(transport, request):
                destinations.append((request.url.scheme, request.url.host, request.url.path))
                request.url = request.url.copy_with(scheme="http", host="127.0.0.1", port=port)
                return await original(transport, request)

        else:

            def forward(transport, request):
                destinations.append((request.url.scheme, request.url.host, request.url.path))
                request.url = request.url.copy_with(scheme="http", host="127.0.0.1", port=port)
                return original(transport, request)

        monkeypatch.setattr(transport_class, method_name, forward)

    # Keep the real Langroid and OpenAI clients and send what they build to the fake provider, noting
    # where it was addressed. Both HTTP stacks and both client kinds, because the OpenAI SDK sends
    # through httpx2 rather than httpx and Langroid may use either the sync or the async client.
    for stack in (httpx, httpx2):
        reroute(stack.HTTPTransport, "handle_request")
        reroute(stack.AsyncHTTPTransport, "handle_async_request")
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("BOT_PROVIDER", "")
    monkeypatch.setenv("BOT_MODEL", "gpt-5.5")
    # A key no other test uses: Langroid caches the OpenAI client it builds by API key, so with the
    # "test-key" above this test would be handed that test's client, already pointed at the fake.
    monkeypatch.setenv("OPENAI_API_KEY", "blank-url-test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "")

    from src import main

    main = importlib.reload(main)
    response = TestClient(main.app).post(
        "/", json=RUN, headers={"x-openbot-agent-token": TOKEN}
    )

    assert destinations == [("https", "api.openai.com", "/v1/chat/completions")]
    assert provider_seen == [("openai", "gpt-5.5")]
    assert response.status_code == 200
    assert '"RUN_FINISHED"' in response.text
    assert '"RUN_ERROR"' not in response.text
    assert "hello" in response.text
