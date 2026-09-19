"""Real ADK/LiteLLM roundtrip; only the provider's HTTP responses are synthetic."""

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import json
from pathlib import Path
import sys
from threading import Thread

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "test-managed-token"
TOOL_NAME = "read_probe_value"
TOOL_VALUE = "value-returned-by-the-client-tool"
TOOL = {
    "name": TOOL_NAME,
    "description": "Read a validation value.",
    "parameters": {
        "type": "object",
        "properties": {"request_id": {"type": "string"}},
        "required": ["request_id"],
    },
}
USER = {"id": "user", "role": "user", "content": "Read the probe value."}


@pytest.fixture
def provider():
    seen = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            seen.append((self.path, self.headers.get("authorization"), body))
            names = [tool["function"]["name"] for tool in body.get("tools", [])]
            results = [message for message in body["messages"] if message["role"] == "tool"]
            delta = {"role": "assistant", "content": "No callable tool was supplied."}
            reason = "stop"
            if results and TOOL_VALUE in json.dumps(results):
                delta = {"role": "assistant", "content": TOOL_VALUE}
            elif TOOL_NAME in names:
                delta = {
                    "role": "assistant",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_probe",
                        "type": "function",
                        "function": {"name": TOOL_NAME, "arguments": '{"request_id":"probe"}'},
                    }],
                }
                reason = "tool_calls"
            base = {"id": "chat_probe", "object": "chat.completion.chunk", "created": 0, "model": body["model"]}
            chunks = [
                {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": reason}]},
            ]
            data = ("".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def harness(monkeypatch, provider):
    base_url, seen = provider
    for name, value in {
        "OPENAI_API_KEY": "synthetic-test-key",
        "OPENAI_BASE_URL": base_url,
        "BOT_PROVIDER": "openai",
        "BOT_MODEL": "gpt-4.1-mini",
        "MANAGED_AGENT_TOKEN": TOKEN,
        "OTEL_SDK_DISABLED": "true",
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    from src import main

    return importlib.reload(main).app, seen


def decode(response):
    assert response.status_code == 200
    events = [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")]
    assert not any(event["type"] == "RUN_ERROR" for event in events), events
    assert any(event["type"] == "RUN_FINISHED" for event in events), events
    return events


def test_client_tool_executes_and_its_result_reaches_the_followup_model(harness):
    app, seen = harness
    executed = []

    def read_probe_value(request_id):
        executed.append(request_id)
        assert request_id == "probe"
        return {"value": TOOL_VALUE}

    async def roundtrip():
        body = {
            "threadId": "tool-roundtrip",
            "runId": "first-run",
            "state": {},
            "context": [],
            "forwardedProps": {},
            "messages": [USER],
            "tools": [TOOL],
        }
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://harness") as client:
            first = decode(await client.post("/", headers={"x-openbot-agent-token": TOKEN}, json=body))
            calls = [event for event in first if event["type"] == "TOOL_CALL_START"]
            assert len(calls) == 1, first
            call = calls[0]
            assert call["toolCallName"] == TOOL_NAME
            arguments = "".join(event["delta"] for event in first if event["type"] == "TOOL_CALL_ARGS" and event["toolCallId"] == call["toolCallId"])
            result = read_probe_value(**json.loads(arguments))
            body.update(runId="followup-run", messages=[
                USER,
                {"id": call.get("parentMessageId", "assistant-tool-call"), "role": "assistant", "toolCalls": [{
                    "id": call["toolCallId"], "type": "function",
                    "function": {"name": TOOL_NAME, "arguments": arguments},
                }]},
                {"id": "tool-result", "role": "tool", "toolCallId": call["toolCallId"], "content": json.dumps(result)},
            ])
            return decode(await client.post("/", headers={"x-openbot-agent-token": TOKEN}, json=body))

    final = asyncio.run(asyncio.wait_for(roundtrip(), timeout=30))
    assert executed == ["probe"]
    assert len(seen) == 2
    for path, authorization, body in seen:
        assert path == "/v1/chat/completions"
        assert authorization == "Bearer synthetic-test-key"
        assert body["model"] == "gpt-4.1-mini"
    tools = seen[0][2]["tools"]
    assert [tool["function"]["name"] for tool in tools] == [TOOL_NAME]
    assert tools[0]["function"]["parameters"]["properties"]["request_id"]["type"] == "string"
    assert tools[0]["function"]["parameters"]["required"] == ["request_id"]
    results = [message for message in seen[1][2]["messages"] if message["role"] == "tool"]
    assert len(results) == 1
    assert TOOL_VALUE in results[0]["content"]
    answer = "".join(event["delta"] for event in final if event["type"] == "TEXT_MESSAGE_CONTENT")
    assert answer == TOOL_VALUE


@pytest.mark.parametrize("headers", [{}, {"x-openbot-agent-token": "wrong-token"}])
def test_client_tools_still_require_the_server_token(harness, headers):
    app, seen = harness

    async def rejected():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://harness") as client:
            return await client.post("/", headers=headers, json={"tools": [TOOL]})

    assert asyncio.run(rejected()).status_code == 401
    assert seen == []
