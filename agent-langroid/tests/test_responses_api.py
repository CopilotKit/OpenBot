"""Every OpenAI model the picker lists takes this Bot's tools, in the request shape it accepts.

OpenAI's own words, as its API answered this Bot before:

- `gpt-5.6` and later on Chat Completions: "Function tools with reasoning_effort are not supported
  for this model in /v1/chat/completions. To use function tools, use /v1/responses".
- The `-pro` models: "This is not a chat model and thus not supported in the v1/chat/completions
  endpoint."
- `gpt-5.5`: "Unsupported value: 'temperature' does not support 0.2 with this model."
- `o3`: "Unsupported parameter: 'parallel_tool_calls' is not supported with this model."

The real Langroid, litellm and AG-UI stack runs here; only the provider at OPENAI_BASE_URL is local,
and it refuses what OpenAI refuses, in OpenAI's words.
"""

import importlib
import json
import sys
import threading
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

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

RESPONSES_MODELS = ["gpt-5.6-luna", "gpt-6-sol", "gpt-6.1-terra", "gpt-6.2-astra", "gpt-5.5-pro", "o3-pro"]
CHAT_MODELS = ["gpt-5.5", "o3", "gpt-4.1-mini"]
REASONING = {"gpt-5.5", "o3", *RESPONSES_MODELS}


def _refusal(model, path, body):
    """OpenAI's refusal for this request, or None when OpenAI takes it."""
    if path == "/v1/chat/completions":
        if model.endswith("-pro"):
            return 404, "This is not a chat model and thus not supported in the v1/chat/completions endpoint."
        if model in RESPONSES_MODELS and body.get("tools"):
            return 400, (
                f"Function tools with reasoning_effort are not supported for {model} in "
                "/v1/chat/completions. To use function tools, use /v1/responses or set "
                "reasoning_effort to 'none'."
            )
    if model in REASONING and "temperature" in body:
        return 400, f"Unsupported value: 'temperature' does not support {body['temperature']} with this model."
    if model == "o3" and "parallel_tool_calls" in body:
        return 400, "Unsupported parameter: 'parallel_tool_calls' is not supported with this model."
    return None


def _chat(body):
    results = [m for m in body["messages"] if m["role"] == "tool"]
    if results:
        message, finish = {"role": "assistant", "content": "Observed: " + results[-1]["content"]}, "stop"
    else:
        message = {
            "role": "assistant",
            "tool_calls": [{"id": "call-chat", "type": "function", "function": {
                "name": body["tools"][0]["function"]["name"], "arguments": json.dumps(ARGUMENTS),
            }}],
        }
        finish = "tool_calls"
    base = {"id": "chat", "created": 0, "model": body["model"]}
    if not body.get("stream"):
        return "application/json", json.dumps({
            **base, "object": "chat.completion",
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })
    delta = deepcopy(message)
    for call in delta.get("tool_calls", []):
        call["index"] = 0
    chunks = [
        {**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
        {**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
    ]
    return "text/event-stream", "".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n"


def _responses(body):
    results = [i for i in body["input"] if i.get("type") == "function_call_output"]
    if results:
        # A result is a string or a list of content parts; OpenAI takes both.
        output = results[-1]["output"]
        if isinstance(output, list):
            output = "".join(part.get("text", "") for part in output)
        item = {"id": "msg", "type": "message", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": "Observed: " + output, "annotations": []}]}
    else:
        item = {"id": "fc", "type": "function_call", "status": "completed", "call_id": "call-responses",
                "name": body["tools"][0]["name"], "arguments": json.dumps(ARGUMENTS)}
    response = {
        "id": "resp-" + uuid4().hex, "object": "response", "created_at": 0, "model": body["model"],
        "status": "completed", "output": [item], "parallel_tool_calls": body.get("parallel_tool_calls", True),
        "tool_choice": "auto", "tools": body.get("tools", []),
        "usage": {"input_tokens": 1, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 1,
                  "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 2},
    }
    if not body.get("stream"):
        return "application/json", json.dumps(response)
    if item["type"] == "message":
        text = item["content"][0]["text"]
        events = [
            {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}},
            {"type": "response.content_part.added", "output_index": 0, "content_index": 0, "item_id": "msg",
             "part": {"type": "output_text", "text": "", "annotations": []}},
            {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "msg", "delta": text},
            {"type": "response.output_text.done", "output_index": 0, "content_index": 0, "item_id": "msg", "text": text},
            {"type": "response.content_part.done", "output_index": 0, "content_index": 0, "item_id": "msg",
             "part": item["content"][0]},
        ]
    else:
        events = [
            {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "arguments": ""}},
            {"type": "response.function_call_arguments.delta", "output_index": 0, "item_id": "fc", "delta": item["arguments"]},
            {"type": "response.function_call_arguments.done", "output_index": 0, "item_id": "fc", "arguments": item["arguments"]},
        ]
    events = [
        {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
        *events,
        {"type": "response.output_item.done", "output_index": 0, "item": item},
        {"type": "response.completed", "response": response},
    ]
    return "text/event-stream", "".join(
        f"event: {e['type']}\ndata: {json.dumps({**e, 'sequence_number': n})}\n\n" for n, e in enumerate(events)
    )


@pytest.fixture
def provider(monkeypatch):
    seen = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            seen.append((self.path, body))
            refused = _refusal(body["model"], self.path, body)
            if refused:
                status, message = refused
                content_type, data = "application/json", json.dumps(
                    {"error": {"message": message, "type": "invalid_request_error", "param": None, "code": None}}
                )
            else:
                status = 200
                content_type, data = (_responses if self.path == "/v1/responses" else _chat)(body)
            data = data.encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-key")
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_USE_CACHED_CLIENT", "false")
    monkeypatch.setenv("OPENAI_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "test-token")
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.delenv("COPILOTKIT_OPENAI_API", raising=False)
    try:
        yield seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _client(monkeypatch, model):
    monkeypatch.setenv("BOT_MODEL", model)
    from src import main

    return TestClient(importlib.reload(main).app)


def _body(messages, thread):
    return {"threadId": thread, "runId": str(uuid4()), "state": {}, "messages": messages,
            "tools": [deepcopy(TOOL)], "context": [], "forwardedProps": {}}


def _run(client, body):
    response = client.post("/", json=body, headers={"x-openbot-agent-token": "test-token"})
    assert response.status_code == 200
    events = [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")]
    assert not [e for e in events if e["type"] == "RUN_ERROR"], events
    assert events[-1]["type"] == "RUN_FINISHED", events
    return events


def _tool_call_then_result(client):
    """A run that streams a tool call, then the run the browser sends back with its result."""
    thread = str(uuid4())
    question = [{"id": "u1", "role": "user", "content": "Where is order A-1001?"}]
    events = _run(client, _body(question, thread))
    start = next((e for e in events if e["type"] == "TOOL_CALL_START"), None)
    assert start is not None, events
    assert start["toolCallName"] == TOOL["name"]
    assert json.loads("".join(e["delta"] for e in events if e["type"] == "TOOL_CALL_ARGS")) == ARGUMENTS
    assert any(e["type"] == "TOOL_CALL_END" for e in events)
    result = "shipped-" + uuid4().hex
    history = [*question, {
        "id": start["parentMessageId"], "role": "assistant", "toolCalls": [{
            "id": start["toolCallId"], "type": "function",
            "function": {"name": TOOL["name"], "arguments": json.dumps(ARGUMENTS)},
        }],
    }, {"id": "t1", "role": "tool", "toolCallId": start["toolCallId"], "content": result}]
    events = _run(client, _body(history, thread))
    text = "".join(e.get("delta", "") for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")
    assert "Observed: " + result in text
    return start, result


@pytest.mark.parametrize("model", RESPONSES_MODELS)
def test_a_responses_only_model_calls_tools_and_reads_results_through_the_responses_api(
    monkeypatch, provider, model
):
    client = _client(monkeypatch, model)

    start, result = _tool_call_then_result(client)

    assert [path for path, _ in provider] == ["/v1/responses", "/v1/responses"]
    first, second = (body for _, body in provider)
    assert first["model"] == model
    tool = next(t for t in first["tools"] if t["name"] == TOOL["name"])
    assert tool["type"] == "function"
    assert tool["parameters"]["properties"] == TOOL["parameters"]["properties"]
    assert "temperature" not in first
    output = next(i for i in second["input"] if i.get("type") == "function_call_output")
    assert output["call_id"] == start["toolCallId"]
    assert result in json.dumps(output["output"])


@pytest.mark.parametrize("model", CHAT_MODELS)
def test_a_model_that_takes_tools_on_chat_completions_gets_only_the_fields_it_accepts(
    monkeypatch, provider, model
):
    client = _client(monkeypatch, model)

    _tool_call_then_result(client)

    assert [path for path, _ in provider] == ["/v1/chat/completions", "/v1/chat/completions"]
    for _, body in provider:
        if model in REASONING:
            assert "temperature" not in body
        if model == "o3":
            assert "parallel_tool_calls" not in body
        else:
            # One call per turn, as Langroid's AG-UI bridge hands calls back one at a time.
            assert body["parallel_tool_calls"] is False


def test_a_model_litellm_does_not_know_stays_on_langroids_own_client(monkeypatch, provider):
    # A model on someone's own hardware, behind an OpenAI-compatible endpoint, and with no key.
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = _client(monkeypatch, "qwen3-8b-local")

    _tool_call_then_result(client)

    assert [path for path, _ in provider] == ["/v1/chat/completions", "/v1/chat/completions"]
    assert provider[0][1]["parallel_tool_calls"] is False
