import importlib
import json
import socket
import sys
import threading
import time
from pathlib import Path

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


@pytest.mark.parametrize(
    ("bot_provider", "model", "expected"),
    [
        ("openai", "gpt-4o-mini", "openai/gpt-4o-mini"),
        ("openai", "qwen/qwen3-8b", "openai/qwen/qwen3-8b"),
        ("openai", "openai/gpt-5.6-terra", "openai/openai/gpt-5.6-terra"),
        ("", "qwen/qwen3-8b", "openai/qwen/qwen3-8b"),
        ("anthropic", "claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"),
    ],
)
def test_model_id_keeps_the_chosen_provider_on_a_name_that_contains_a_slash(
    monkeypatch, bot_provider, model, expected
):
    monkeypatch.setenv("BOT_PROVIDER", bot_provider)
    monkeypatch.setenv("BOT_MODEL", model)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("OPENAI_API_KEY", "no-key-needed")
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)

    from src import main

    main = importlib.reload(main)
    assert main._model_id() == expected


CHOICES = {
    "an OpenAI-compatible endpoint that namespaces its catalogue": (
        lambda base: {
            "BOT_PROVIDER": "",
            "BOT_MODEL": "openai/gpt-5.6-terra",
            "OPENAI_API_KEY": "no-key-needed",
            "OPENAI_BASE_URL": f"{base}/v1",
            "ANTHROPIC_API_KEY": "",
        },
        ("openai", "openai/gpt-5.6-terra"),
    ),
    "an OpenAI-compatible endpoint whose model name contains a slash": (
        lambda base: {
            "BOT_PROVIDER": "",
            "BOT_MODEL": "qwen/qwen3-8b",
            "OPENAI_API_KEY": "no-key-needed",
            "OPENAI_BASE_URL": f"{base}/v1",
            "ANTHROPIC_API_KEY": "",
        },
        ("openai", "qwen/qwen3-8b"),
    ),
}


@pytest.mark.parametrize("choice", list(CHOICES))
def test_a_run_sends_a_namespaced_model_name_verbatim(monkeypatch, provider, choice):
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
