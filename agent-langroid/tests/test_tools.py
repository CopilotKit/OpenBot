"""The real Langroid/AG-UI stack, with only provider HTTP replaced."""

import importlib
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ARGUMENTS = {"selection": {"labels": ["first", "second"], "enabled": True}}
TOOL = {
    "name": "read_selection",
    "description": "Read the selected items.",
    "parameters": {
        "type": "object",
        "properties": {"selection": {"$ref": "#/$defs/Selection"}},
        "required": ["selection"],
        "additionalProperties": False,
        "$defs": {
            "Selection": {
                "type": "object",
                "properties": {
                    "labels": {"type": "array", "items": {"type": "string"}},
                    "enabled": {"type": "boolean"},
                },
                "required": ["labels", "enabled"],
                "additionalProperties": False,
            }
        },
    },
}


@pytest.fixture
def boundary(monkeypatch):
    requests = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            requests.append(body)
            last = body["messages"][-1]
            if last["role"] == "tool" and last["content"] != "CALL_AGAIN":
                message = {"role": "assistant", "content": "Observed: " + last["content"]}
                finish = "stop"
            elif body.get("tools"):
                name = body["tools"][0]["function"]["name"]
                message = {
                    "role": "assistant",
                    "tool_calls": [{"id": "provider-call", "type": "function", "function": {
                        "name": name, "arguments": json.dumps(ARGUMENTS),
                    }}],
                }
                finish = "tool_calls"
            else:
                message = {"role": "assistant", "content": "No tools offered: " + last["content"]}
                finish = "stop"
            if body.get("stream"):
                delta = deepcopy(message)
                for call in delta.get("tool_calls", []):
                    call["index"] = 0
                base = {"id": "chat", "object": "chat.completion.chunk", "created": 0, "model": body["model"]}
                chunks = [
                    {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                    {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
                ]
                data = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
                content_type = "text/event-stream"
            else:
                data = json.dumps({"id": "chat", "object": "chat.completion", "created": 0, "model": body["model"],
                    "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
                content_type = "application/json"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-key")
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.setenv("BOT_MODEL", "gpt-4.1-mini")
    # Each test owns a different HTTP server; don't reuse a client for a closed port.
    monkeypatch.setenv("OPENAI_USE_CACHED_CLIENT", "false")
    monkeypatch.setenv("OPENAI_BASE_URL", f"http://127.0.0.1:{provider.server_port}/v1")
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "test-token")
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    try:
        from src import main

        main = importlib.reload(main)
        yield TestClient(main.app), requests
    finally:
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=5)


def body(*, tools=None, messages=None, thread=None):
    return {
        "threadId": thread or str(uuid4()), "runId": str(uuid4()), "state": {},
        "messages": messages or [{"id": "user", "role": "user", "content": "Read the selected items."}],
        "tools": [deepcopy(TOOL)] if tools is None else tools,
        "context": [], "forwardedProps": {},
    }


def run(client, request):
    response = client.post("/", json=request, headers={"x-openbot-agent-token": "test-token"})
    assert response.status_code == 200
    events = [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")]
    assert not [event for event in events if event["type"] == "RUN_ERROR"], events
    assert events[-1]["type"] == "RUN_FINISHED", events
    return events


def tool_call(events):
    start = next(event for event in events if event["type"] == "TOOL_CALL_START")
    arguments = "".join(event["delta"] for event in events if event["type"] == "TOOL_CALL_ARGS")
    return start, json.loads(arguments)


def result_history(request, start, arguments, result):
    return [*request["messages"], {
        "id": start["parentMessageId"], "role": "assistant", "toolCalls": [{
            "id": start["toolCallId"], "type": "function",
            "function": {"name": start["toolCallName"], "arguments": json.dumps(arguments)},
        }],
    }, {"id": "result", "role": "tool", "toolCallId": start["toolCallId"], "content": result}]


def test_dynamic_nested_schema_and_real_result_reach_the_sdk(boundary):
    from langroid.utils.object_registry import ObjectRegistry

    client, requests = boundary
    registered_before = set(ObjectRegistry.registry)
    request = body()
    start, arguments = tool_call(run(client, request))
    assert requests[0]["tools"][0]["function"]["parameters"] == TOOL["parameters"]
    assert requests[0]["parallel_tool_calls"] is False
    assert arguments == ARGUMENTS
    result = "returned-value-" + str(uuid4())
    followup = body(thread=request["threadId"], messages=result_history(request, start, arguments, result))
    events = run(client, followup)
    assert requests[1]["messages"][-1] == {"role": "tool", "content": result, "tool_call_id": start["toolCallId"]}
    assert result in "".join(e.get("delta", "") for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")
    assert all(m.get("content") not in {"Done", "Done!"} for m in requests[1]["messages"])
    assert set(ObjectRegistry.registry) == registered_before


def test_followup_can_request_another_tool(boundary):
    client, requests = boundary
    request = body()
    start, arguments = tool_call(run(client, request))
    followup = body(thread=request["threadId"], messages=result_history(request, start, arguments, "CALL_AGAIN"))
    next_start, next_arguments = tool_call(run(client, followup))
    assert next_start["toolCallName"] == TOOL["name"]
    assert next_arguments == ARGUMENTS
    assert requests[1]["messages"][-1]["content"] == "CALL_AGAIN"


def test_current_input_replaces_tools_and_history_even_on_the_same_thread(boundary):
    client, requests = boundary
    thread = str(uuid4())
    run(client, body(thread=thread))
    run(client, body(thread=thread, tools=[], messages=[{"id": "new", "role": "user", "content": "Independent current history."}]))
    assert not requests[1].get("tools")
    assert [m["content"] for m in requests[1]["messages"] if m["role"] == "user"] == ["Independent current history."]
    assert not any(m.get("tool_calls") or m["role"] == "tool" for m in requests[1]["messages"])


def test_concurrent_runs_do_not_share_tool_schemas_or_messages(boundary):
    client, requests = boundary
    thread = str(uuid4())
    inputs = []
    for name in ["first", "second"]:
        tool = {**deepcopy(TOOL), "name": name}
        inputs.append(body(thread=thread, tools=[tool], messages=[{"id": name, "role": "user", "content": name}]))
    with ThreadPoolExecutor(max_workers=2) as pool:
        outputs = list(pool.map(lambda request: run(client, request), inputs))
    assert [tool_call(events)[0]["toolCallName"] for events in outputs] == ["first", "second"]
    assert len(requests) == 2
    for request in requests:
        tool_name = request["tools"][0]["function"]["name"]
        assert [m["content"] for m in request["messages"] if m["role"] == "user"] == [tool_name]
