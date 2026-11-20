"""Real framework/provider contract shared by isolated harness pytest jobs.

Only the model's HTTP endpoint is synthetic. The harness, framework, AG-UI
adapter, tool schemas, history conversion and continuation all execute normally.
"""

import asyncio
import importlib
import json
import sys
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from uuid import uuid4

import httpx

CATALOG = "Published skills: refunds — apply the learned refund policy."
SKILL = "Refund policy: consult supporting.txt before answering."
SUPPORT = "The approved refund window is 37 days."
LOAD = "copilotkit_load_skill"
READ = "copilotkit_read_skill_file"
TOOLS = [
    {
        "name": name,
        "description": "Read published skill guidance.",
        "parameters": {
            "type": "object",
            "properties": {
                "skill_name": {"type": "string"},
                **({"path": {"type": "string"}} if name == READ else {}),
            },
            "required": ["skill_name", *(["path"] if name == READ else [])],
            "additionalProperties": False,
        },
    }
    for name in [LOAD, READ]
]


def _reply(body):
    history = json.dumps(body.get("messages", body.get("input", [])))
    if SUPPORT in history:
        return {"role": "assistant", "content": SUPPORT}, "stop"
    name = READ if SKILL in history else LOAD
    arguments = {"skill_name": "refunds"}
    if name == READ:
        arguments["path"] = "supporting.txt"
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [{
            "id": f"call_{name}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)},
        }],
    }, "tool_calls"


def _responses_events(body, message):
    response = {
        "id": "response_" + str(uuid4()), "object": "response", "created_at": 0,
        "model": body["model"], "status": "in_progress", "output": [],
        "parallel_tool_calls": True, "tool_choice": "auto", "tools": [],
    }
    call = next(iter(message.get("tool_calls", [])), None)
    if call:
        item = {
            "id": "function_" + call["id"], "type": "function_call",
            "call_id": call["id"], "name": call["function"]["name"],
            "arguments": call["function"]["arguments"], "status": "completed",
        }
        delta = {"type": "response.function_call_arguments.delta", "delta": item["arguments"]}
    else:
        item = {
            "id": "answer", "type": "message", "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": message["content"], "annotations": []}],
        }
        delta = {"type": "response.output_text.delta", "content_index": 0, "delta": message["content"], "logprobs": []}
    events = [
        {"type": "response.created", "response": response},
        {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", **({"arguments": ""} if call else {"content": []})}},
        {**delta, "item_id": item["id"], "output_index": 0},
        {"type": "response.output_item.done", "output_index": 0, "item": item},
        {"type": "response.completed", "response": {
            **response, "status": "completed", "output": [item],
            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
                      "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}},
        }},
    ]
    return "".join(f"event: {event['type']}\ndata: {json.dumps({**event, 'sequence_number': index})}\n\n" for index, event in enumerate(events)).encode()



def _normalize_chunks(events):
    # The server's Middleware.runNext uses AG-UI transformChunks. Some native
    # adapters (AG2) use that compact wire form instead of START/ARGS/END.
    normalized = []
    tools = set()
    text = set()
    for event in events:
        if event["type"] == "TOOL_CALL_CHUNK":
            identity = event.get("toolCallId") or next(reversed(tuple(tools)))
            if identity not in tools:
                tools.add(identity)
                normalized.append({**event, "type": "TOOL_CALL_START", "toolCallId": identity})
            if "delta" in event:
                normalized.append({**event, "type": "TOOL_CALL_ARGS", "toolCallId": identity})
        elif event["type"] == "TEXT_MESSAGE_CHUNK":
            identity = event.get("messageId") or next(reversed(tuple(text)))
            text.add(identity)
            if "delta" in event:
                normalized.append({**event, "type": "TEXT_MESSAGE_CONTENT", "messageId": identity})
        else:
            normalized.append(event)
    return normalized

def assert_learning_delivery(monkeypatch, harness, route="/"):
    seen = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            seen.append(body)
            message, reason = _reply(body)
            if self.path.endswith("/responses"):
                data, content_type = _responses_events(body, message), "text/event-stream"
            elif body.get("stream"):
                delta = deepcopy(message)
                for index, call in enumerate(delta.get("tool_calls", [])):
                    call["index"] = index
                base = {"id": "chat", "object": "chat.completion.chunk", "created": 0, "model": body["model"]}
                chunks = [
                    {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                    {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": reason}]},
                ]
                data = ("".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
                content_type = "text/event-stream"
            else:
                data = json.dumps({
                    "id": "chat", "object": "chat.completion", "created": 0, "model": body["model"],
                    "choices": [{"index": 0, "message": message, "finish_reason": reason}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }).encode()
                content_type = "application/json"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    for key, value in {
        "BOT_PROVIDER": "openai", "BOT_MODEL": "gpt-4.1-mini",
        "OPENAI_API_KEY": "synthetic-provider-key", "MANAGED_AGENT_TOKEN": "test-token",
        "OPENAI_BASE_URL": f"http://127.0.0.1:{provider.server_port}/v1",
        "OPENAI_USE_CACHED_CLIENT": "false", "OTEL_SDK_DISABLED": "true",
        "CREWAI_TRACING_ENABLED": "false",
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.delenv("CPK_INTELLIGENCE_API_KEY", raising=False)
    try:
        # CrewAI intentionally installs its input projector once at import;
        # its model configuration is resolved at run time. Other harnesses
        # construct their configured models at import and may be preloaded by
        # their existing test module during collection.
        loaded = sys.modules.get("src.main")
        main = (
            importlib.reload(loaded)
            if loaded is not None and harness != "agent-crewai"
            else importlib.import_module("src.main")
        )
        app = main.app
        body = {
            "threadId": "learning_" + str(uuid4()), "runId": str(uuid4()), "state": {},
            "messages": [
                {"id": "openbot:learned-skills", "role": "system", "content": CATALOG},
                {"id": "user", "role": "user", "content": "Apply the refund policy."},
            ],
            "context": [{"description": "OpenBot learned skills", "value": CATALOG}],
            "tools": TOOLS, "forwardedProps": {"openbotDeploymentTools": []},
        }

        async def roundtrip():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://harness", follow_redirects=True) as client:
                for expected_name, result in [(LOAD, SKILL), (READ, SUPPORT), (None, None)]:
                    response = await client.post(route, headers={"x-openbot-agent-token": "test-token"}, json=body)
                    assert response.status_code == 200, (harness, response.text)
                    events = _normalize_chunks([json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")])
                    assert not [event for event in events if event["type"] == "RUN_ERROR"], (harness, events)
                    assert any(event["type"] == "RUN_FINISHED" for event in events), (harness, events)
                    calls = [event for event in events if event["type"] == "TOOL_CALL_START"]
                    snapshots = [event["messages"] for event in events if event["type"] == "MESSAGES_SNAPSHOT"]
                    if not calls and snapshots:
                        answered = {message["toolCallId"] for message in snapshots[-1] if message["role"] == "tool"}
                        for message in snapshots[-1]:
                            for call in message.get("toolCalls", []):
                                if call["id"] in answered:
                                    continue
                                calls.append({"type": "TOOL_CALL_START", "toolCallId": call["id"], "toolCallName": call["function"]["name"], "parentMessageId": message["id"]})
                                events.append({"type": "TOOL_CALL_ARGS", "toolCallId": call["id"], "delta": call["function"]["arguments"]})
                    if expected_name is None:
                        assert not calls, (harness, events)
                        answer = "".join(event.get("delta", "") for event in events if event["type"] == "TEXT_MESSAGE_CONTENT")
                        if not answer and snapshots:
                            answer = snapshots[-1][-1].get("content", "")
                        assert SUPPORT in answer, (harness, events)
                        return
                    assert len(calls) == 1 and calls[0]["toolCallName"] == expected_name, (harness, events)
                    call = calls[0]
                    arguments = "".join(event["delta"] for event in events if event["type"] == "TOOL_CALL_ARGS" and event["toolCallId"] == call["toolCallId"])
                    assert arguments, (harness, events)
                    assert json.loads(arguments) == {"skill_name": "refunds", **({"path": "supporting.txt"} if expected_name == READ else {})}
                    body["messages"].extend([
                        {"id": call.get("parentMessageId") or str(uuid4()), "role": "assistant", "toolCalls": [{"id": call["toolCallId"], "type": "function", "function": {"name": expected_name, "arguments": arguments}}]},
                        {"id": str(uuid4()), "role": "tool", "toolCallId": call["toolCallId"], "content": result},
                    ])
                    body["runId"] = str(uuid4())
        asyncio.run(asyncio.wait_for(roundtrip(), timeout=30))
        assert len(seen) == 3, (harness, seen)
        assert CATALOG in json.dumps(seen[0], ensure_ascii=False), (harness, seen[0])
        names = {tool.get("name", tool.get("function", {}).get("name")) for tool in seen[0].get("tools", [])}
        assert {LOAD, READ}.issubset(names), (harness, names)
        assert SKILL in json.dumps(seen[1]) and SUPPORT in json.dumps(seen[2]), (harness, seen)
    finally:
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=5)
