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

    # `OpenAIChatClient` is the Responses API in Agent Framework, so that is the route an OpenAI key
    # and an OpenAI-compatible endpoint both reach.
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
    assert "hello" in response.text
    assert seen == [expected]
