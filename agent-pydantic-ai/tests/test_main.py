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
from fastapi.responses import StreamingResponse
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
        for name, data in events:
            yield f"event: {name}\ndata: {json.dumps(data)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


def _provider_app(seen):
    app = FastAPI()

    # `openai:` is the Responses API in Pydantic AI, so that is the route an OpenAI key and an
    # OpenAI-compatible endpoint both reach.
    @app.post("/v1/responses")
    async def openai_responses(request: Request):
        body = await request.json()
        seen.append(("openai", body["model"]))
        response = {
            "id": "resp",
            "object": "response",
            "created_at": 0,
            "model": body["model"],
            "status": "in_progress",
            "output": [],
            "parallel_tool_calls": True,
            "tool_choice": "auto",
            "tools": [],
        }
        item = {"id": "msg", "type": "message", "role": "assistant", "status": "completed"}
        text = {"type": "output_text", "text": "hello", "annotations": []}
        done = {
            **response,
            "status": "completed",
            "output": [{**item, "content": [text]}],
            "usage": {
                "input_tokens": 1,
                "input_tokens_details": {"cached_tokens": 0},
                "output_tokens": 1,
                "output_tokens_details": {"reasoning_tokens": 0},
                "total_tokens": 2,
            },
        }
        return _sse(
            [
                ("response.created", {"type": "response.created", "sequence_number": 0, "response": response}),
                ("response.output_item.added", {"type": "response.output_item.added", "sequence_number": 1, "output_index": 0, "item": {**item, "status": "in_progress", "content": []}}),
                ("response.output_text.delta", {"type": "response.output_text.delta", "sequence_number": 2, "item_id": "msg", "output_index": 0, "content_index": 0, "delta": "hello", "logprobs": []}),
                ("response.output_item.done", {"type": "response.output_item.done", "sequence_number": 3, "output_index": 0, "item": {**item, "content": [text]}}),
                ("response.completed", {"type": "response.completed", "sequence_number": 4, "response": done}),
            ]
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
        return _sse(
            [
                ("message_start", {"type": "message_start", "message": {**message, "content": [], "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 0}}}),
                ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hello"}}),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
                ("message_stop", {"type": "message_stop"}),
            ]
        )

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


def _endpoint(model):
    """What the desktop writes for an OpenAI-compatible endpoint serving `model`."""
    return (
        lambda base: {
            "BOT_PROVIDER": "",
            "BOT_MODEL": model,
            "OPENAI_API_KEY": "no-key-needed",
            "OPENAI_BASE_URL": f"{base}/v1",
            "ANTHROPIC_API_KEY": "",
        },
        ("openai", model),
    )


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
    # Written the way Pydantic AI names a model, which still reaches that provider.
    "a model already named with its provider": (
        lambda base: {
            "BOT_PROVIDER": "anthropic",
            "BOT_MODEL": "anthropic:claude-sonnet-4-5",
            "ANTHROPIC_API_KEY": "test-key",
            "ANTHROPIC_BASE_URL": base,
            "OPENAI_API_KEY": "",
            "OPENAI_BASE_URL": "",
        },
        ("anthropic", "claude-sonnet-4-5"),
    ),
    "an OpenAI-compatible endpoint": _endpoint("local-model"),
    # Ollama names every model with its tag after a colon, which is the separator Pydantic AI puts
    # between a provider and a model.
    "an Ollama model named with its tag": _endpoint("llama3.1:8b"),
    # And a tag on a model that shares its name with a provider Pydantic AI knows.
    "an Ollama model named like a provider": _endpoint("mistral:7b"),
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
    monkeypatch.setenv("PYDANTIC_AI_NO_BANNER", "1")
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
    assert "hello" in response.text
    assert seen == [expected]


# What Compose passes for the two plain keys: the key, and the endpoint it did not need as "".
BLANK_URLS = {
    "an OpenAI key": (
        {"BOT_PROVIDER": "openai", "BOT_MODEL": "gpt-5.5", "OPENAI_API_KEY": "test-key", "ANTHROPIC_API_KEY": ""},
        ("https", "api.openai.com", "/v1/responses"),
        ("openai", "gpt-5.5"),
    ),
    "an Anthropic key": (
        {"BOT_PROVIDER": "anthropic", "BOT_MODEL": "claude-sonnet-4-5", "ANTHROPIC_API_KEY": "test-key", "OPENAI_API_KEY": ""},
        ("https", "api.anthropic.com", "/v1/messages"),
        ("anthropic", "claude-sonnet-4-5"),
    ),
}


@pytest.mark.parametrize("choice", list(BLANK_URLS))
def test_a_key_reaches_the_official_endpoint_when_compose_leaves_the_url_blank(monkeypatch, choice):
    environment, destination, expected = BLANK_URLS[choice]
    seen = []
    provider_seen = []
    provider_app = _provider_app(provider_seen)

    def respond_with(module):
        async def respond(transport, request):
            seen.append((request.url.scheme, request.url.host, request.url.path))
            async with module.ASGITransport(app=provider_app) as local_provider:
                return await local_provider.handle_async_request(request)

        return respond

    # Keep the real Pydantic AI and SDK clients; replace only the network transport, on both HTTP
    # stacks, because the OpenAI SDK sends through httpx2 rather than httpx.
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", respond_with(httpx))
    monkeypatch.setattr(httpx2.AsyncHTTPTransport, "handle_async_request", respond_with(httpx2))
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("PYDANTIC_AI_NO_BANNER", "1")
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "")
    for key, value in environment.items():
        monkeypatch.setenv(key, value)

    from src import main

    main = importlib.reload(main)
    response = TestClient(main.app).post(
        "/", json=RUN, headers={"x-openbot-agent-token": TOKEN}
    )

    assert seen == [destination]
    assert provider_seen == [expected]
    assert response.status_code == 200
    assert '"RUN_FINISHED"' in response.text
    assert '"RUN_ERROR"' not in response.text
    assert "hello" in response.text
