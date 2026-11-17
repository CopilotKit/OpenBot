"""OpenAI models that take function tools only on the Responses API get it, tools and results alike.

OpenAI's own words for `gpt-5.6` and later on Chat Completions: "Function tools with
reasoning_effort are not supported for this model in /v1/chat/completions. To use function tools,
use /v1/responses". The `-pro` models are not served there at all: "This is not a chat model and
thus not supported in the v1/chat/completions endpoint." The real AG2 and OpenAI clients run here;
only the provider at the other end of OPENAI_BASE_URL is local, and it answers the way OpenAI
does, refusals included.
"""

import importlib
import json
import socket
import sys
import threading
import time
from pathlib import Path
from uuid import uuid4

import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "responses-token"
TOOL = {
    "name": "look_up_order",
    "description": "Look up the status of an order by its number.",
    "parameters": {
        "type": "object",
        "properties": {"order": {"type": "string", "description": "The order number."}},
        "required": ["order"],
    },
}
ARGUMENTS = {"order": "A-1001"}

# What the picker lists that OpenAI serves function tools for only on /v1/responses.
RESPONSES_MODELS = ["gpt-5.6-luna", "gpt-6-sol", "gpt-6.1-terra", "gpt-6.2-astra", "gpt-5.5-pro", "o3-pro"]
# Reasoning and non-reasoning models that still take tools on Chat Completions.
CHAT_MODELS = ["gpt-5.5", "o3", "gpt-4.1-mini"]
REASONING = {"gpt-5.5", "o3", *RESPONSES_MODELS}


def _provider_app(seen):
    app = FastAPI()

    def refuse(message, status=400):
        return JSONResponse(
            {"error": {"message": message, "type": "invalid_request_error", "param": None, "code": None}},
            status_code=status,
        )

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        body = await request.json()
        seen.append(("/v1/chat/completions", body))
        model = body["model"]
        if model.endswith("-pro"):
            return refuse("This is not a chat model and thus not supported in the v1/chat/completions endpoint.", 404)
        if model in RESPONSES_MODELS and body.get("tools"):
            return refuse(
                f"Function tools with reasoning_effort are not supported for {model} in "
                "/v1/chat/completions. To use function tools, use /v1/responses or set "
                "reasoning_effort to 'none'."
            )
        if model in REASONING and "temperature" in body:
            return refuse("Unsupported value: 'temperature' does not support 0.2 with this model.")
        if model == "o3" and "parallel_tool_calls" in body:
            return refuse("Unsupported parameter: 'parallel_tool_calls' is not supported with this model.")
        # AG2 follows a tool result with an empty user turn on this API, so look for the result.
        results = [m for m in body["messages"] if m["role"] == "tool"]
        if results:
            message = {"role": "assistant", "content": "Observed: " + results[-1]["content"]}
            finish = "stop"
        else:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call-chat",
                        "type": "function",
                        "function": {"name": TOOL["name"], "arguments": json.dumps(ARGUMENTS)},
                    }
                ],
            }
            finish = "tool_calls"
        return JSONResponse(
            {
                "id": "chat",
                "object": "chat.completion",
                "created": 0,
                "model": model,
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        )

    @app.post("/v1/responses")
    async def responses(request: Request):
        body = await request.json()
        seen.append(("/v1/responses", body))
        if body["model"] in REASONING and "temperature" in body:
            return refuse("Unsupported parameter: 'temperature' is not supported with this model.")
        results = [item for item in body["input"] if item.get("type") == "function_call_output"]
        if results:
            output = [
                {
                    "id": "msg",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {"type": "output_text", "text": "Observed: " + results[-1]["output"], "annotations": []}
                    ],
                }
            ]
        else:
            output = [
                {
                    "id": "fc",
                    "type": "function_call",
                    "status": "completed",
                    "call_id": "call-responses",
                    "name": body["tools"][0]["name"],
                    "arguments": json.dumps(ARGUMENTS),
                }
            ]
        return JSONResponse(
            {
                "id": "resp-" + uuid4().hex,
                "object": "response",
                "created_at": 0,
                "model": body["model"],
                "status": "completed",
                "output": output,
                "parallel_tool_calls": body.get("parallel_tool_calls", True),
                "tool_choice": "auto",
                "tools": body.get("tools", []),
                # The usage OpenAI reports, details included: AG2 reads them.
                "usage": {
                    "input_tokens": 1,
                    "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
                    "output_tokens": 1,
                    "output_tokens_details": {"reasoning_tokens": 0},
                    "total_tokens": 2,
                },
            }
        )

    return app


@pytest.fixture
def provider():
    seen = []
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(_provider_app(seen), host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    yield f"http://127.0.0.1:{port}", seen
    server.should_exit = True
    thread.join(timeout=10)


def _app(monkeypatch, base, model, api=None):
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    if api is None:
        monkeypatch.delenv("COPILOTKIT_OPENAI_API", raising=False)
    else:
        monkeypatch.setenv("COPILOTKIT_OPENAI_API", api)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.setenv("BOT_MODEL", model)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", f"{base}/v1")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    from src import main

    return TestClient(importlib.reload(main).app)


def _body(messages, thread):
    return {
        "threadId": thread,
        "runId": str(uuid4()),
        "state": {},
        "messages": messages,
        "tools": [TOOL],
        "context": [],
        "forwardedProps": {},
    }


def _run(client, body):
    response = client.post("/", json=body, headers={"x-openbot-agent-token": TOKEN})
    assert response.status_code == 200
    events = [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")]
    assert not [e for e in events if e["type"] == "RUN_ERROR"], events
    assert events[-1]["type"] == "RUN_FINISHED", events
    return events


def _tool_call_then_result(client):
    """One run that calls the tool, then the run the browser sends back with the tool's result."""
    thread = str(uuid4())
    question = [{"id": "u1", "role": "user", "content": "Where is order A-1001?"}]
    events = _run(client, _body(question, thread))
    # AG2 sends a call as AG-UI's TOOL_CALL_CHUNK, which a client expands to start, args and end.
    start = next((e for e in events if e["type"] in ("TOOL_CALL_START", "TOOL_CALL_CHUNK")), None)
    assert start is not None, events
    arguments = json.loads(
        "".join(e.get("delta") or "" for e in events if e["type"] in ("TOOL_CALL_ARGS", "TOOL_CALL_CHUNK"))
    )
    assert start["toolCallName"] == TOOL["name"]
    assert arguments == ARGUMENTS
    assert any(e["type"] == "RUN_FINISHED" and start["toolCallId"] in json.dumps(e) for e in events)
    result = "shipped-" + uuid4().hex
    history = [
        *question,
        {
            "id": start.get("parentMessageId") or "a1",
            "role": "assistant",
            "toolCalls": [
                {
                    "id": start["toolCallId"],
                    "type": "function",
                    "function": {"name": TOOL["name"], "arguments": json.dumps(arguments)},
                }
            ],
        },
        {"id": "t1", "role": "tool", "toolCallId": start["toolCallId"], "content": result},
    ]
    events = _run(client, _body(history, thread))
    text = "".join(e.get("delta", "") for e in events if e["type"] in ("TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK"))
    assert "Observed: " + result in text
    return start, result


@pytest.mark.parametrize("model", RESPONSES_MODELS)
def test_a_responses_only_model_calls_tools_and_reads_results_through_the_responses_api(
    monkeypatch, provider, model
):
    base, seen = provider
    client = _app(monkeypatch, base, model)

    start, result = _tool_call_then_result(client)

    assert [path for path, _ in seen] == ["/v1/responses", "/v1/responses"]
    first, second = (body for _, body in seen)
    assert first["model"] == model
    tool = next(t for t in first["tools"] if t["name"] == TOOL["name"])
    assert tool["type"] == "function"
    assert tool["parameters"]["properties"] == TOOL["parameters"]["properties"]
    assert "temperature" not in first
    assert {
        "type": "function_call_output",
        "call_id": start["toolCallId"],
        "output": result,
    }.items() <= next(i for i in second["input"] if i.get("type") == "function_call_output").items()


@pytest.mark.parametrize("model", CHAT_MODELS)
def test_a_model_that_takes_tools_on_chat_completions_stays_there_without_refused_fields(
    monkeypatch, provider, model
):
    base, seen = provider
    client = _app(monkeypatch, base, model)

    _tool_call_then_result(client)

    assert [path for path, _ in seen] == ["/v1/chat/completions", "/v1/chat/completions"]
    for _, body in seen:
        assert "temperature" not in body
        if model == "o3":
            assert "parallel_tool_calls" not in body


@pytest.mark.parametrize(("api", "model", "path"), [
    ("chat", "gpt-5.5", "/v1/chat/completions"),
    ("responses", "gpt-4.1-mini", "/v1/responses"),
])
def test_an_operator_choice_of_openai_api_wins(monkeypatch, provider, api, model, path):
    base, seen = provider
    client = _app(monkeypatch, base, model, api=api)

    _tool_call_then_result(client)

    assert [p for p, _ in seen] == [path, path]
