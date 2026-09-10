"""Production AG-UI endpoint -> real model SDK -> controlled HTTP boundary.

No provider credentials, auth stores, Docker or native UI are used. The response
server is deterministic; these checks are protocol regressions, not live bot proof.
"""

import asyncio
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from uuid import uuid4

import httpx
import httpx2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import main
from test_provider_boundaries import (
    _install_loopback_socket_guard,
    _write_synthetic_chatgpt_store,
)


def tool(name):
    return {
        "name": name,
        "description": "Public protocol proof",
        "parameters": {
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
        },
    }


@pytest.fixture
def boundary(monkeypatch):
    _install_loopback_socket_guard()
    for name in [
        "CHATGPT_AUTH_FILE",
        "OPENAI_BASE_URL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GOOGLE_GENERATIVE_AI_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENBOT_TOOL_URL",
        "AGENT_TOOL_TOKEN",
    ]:
        monkeypatch.delenv(name, raising=False)
    for name, value in {
        "BOT_PROVIDER": "openai",
        "BOT_MODEL": "protocol-proof",
        "OPENAI_API_KEY": "synthetic-model-key",
        "MANAGED_AGENT_TOKEN": "synthetic-server-token",
    }.items():
        monkeypatch.setenv(name, value)
    captured = {"model": [], "callback": [], "callback_status": 200, "force_call": None}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/api/agent-tools/call":
                captured["callback"].append(
                    {"body": body, "token": self.headers.get("x-openbot-agent-token")}
                )
                status = captured["callback_status"]
                if authorize := captured.get("callback_authorize"):
                    status = authorize(body, self.headers.get("x-openbot-agent-token"))
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({"text": "deployment result: public marker 43"}).encode()
                )
                return
            captured["model"].append(body)
            messages = body["messages"]
            user = next(m["content"] for m in reversed(messages) if m["role"] == "user")
            names = user.split(",")
            requested_names = (
                [captured["force_call"]] if captured["force_call"] else names
            )
            offered = {t["function"]["name"] for t in body.get("tools", [])}
            if messages[-1]["role"] == "tool":
                content = "Observed tool result: " + messages[-1]["content"]
                delta = {"role": "assistant", "content": content}
                finish = "stop"
            elif all(name in offered for name in names):
                delta = {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "index": i,
                            "id": "call-" + name,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps({"value": "public marker"}),
                            },
                        }
                        for i, name in enumerate(requested_names)
                    ],
                }
                finish = "tool_calls"
            else:
                delta = {"role": "assistant", "content": "No tool was offered."}
                finish = "stop"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            # Real streaming boundary: each call's indexed fragment arrives as
            # an SSE chunk. The separately retained batched-chunk diagnostic
            # exposes the installed upstream adapter's first-chunk limitation.
            parts = (
                [
                    {"role": "assistant", "tool_calls": [call]}
                    for call in delta["tool_calls"]
                ]
                if "tool_calls" in delta
                else [delta]
            )
            for part, reason in [*((part, None) for part in parts), ({}, finish)]:
                chunk = {
                    "id": "response-proof",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": "protocol-proof",
                    "choices": [{"index": 0, "delta": part, "finish_reason": reason}],
                }
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("OPENAI_BASE_URL", base + "/v1")
    monkeypatch.setenv("OPENBOT_TOOL_URL", base + "/api/agent-tools/call")
    monkeypatch.setenv("AGENT_TOOL_TOKEN", "synthetic-callback-token")
    try:
        yield captured
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def run_input(
    names,
    *,
    thread=None,
    messages=None,
    deployment=(),
    assertion="synthetic-run-assertion",
):
    return {
        "threadId": thread or str(uuid4()),
        "runId": str(uuid4()),
        "messages": messages
        or [{"id": "user-" + str(uuid4()), "role": "user", "content": ",".join(names)}],
        "tools": [tool(name) for name in names],
        "context": [],
        "state": {},
        "forwardedProps": {
            "openbotDeploymentTools": list(deployment),
            "openbotRun": assertion,
        },
    }


async def run_protocol(body, *, allow_error=False):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/", json=body, headers={"x-openbot-agent-token": "synthetic-server-token"}
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    if not allow_error:
        assert not [e for e in events if e["type"] == "RUN_ERROR"], events
        assert events[-1]["type"] == "RUN_FINISHED", events
    return events


def snapshot(events):
    return next(
        e["messages"] for e in reversed(events) if e["type"] == "MESSAGES_SNAPSHOT"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["computer_navigate", "computer_run_command"])
async def test_surface_tool_calls_end_then_consume_actual_client_result(boundary, name):
    body = run_input([name])
    first = await run_protocol(body)
    assert [t["function"]["name"] for t in boundary["model"][0].get("tools", [])] == [
        name
    ]
    assert any(
        e["type"] == "TOOL_CALL_START" and e["toolCallName"] == name for e in first
    )
    assert boundary["callback"] == []
    assert len(boundary["model"]) == 1
    history = snapshot(first)
    history.append(
        {
            "id": "result-public",
            "role": "tool",
            "toolCallId": "call-" + name,
            "content": "actual client result: public marker 43",
        }
    )
    second = await run_protocol(
        run_input([name], thread=body["threadId"], messages=history)
    )
    assert (
        boundary["model"][-1]["messages"][-1]["content"]
        == "actual client result: public marker 43"
    )
    assert any(
        "actual client result: public marker 43" in m.get("content", "")
        for m in snapshot(second)
    )
    assert boundary["callback"] == []


@pytest.mark.asyncio
async def test_deployment_tool_executes_only_via_signed_callback_and_continues(
    boundary,
):
    events = await run_protocol(
        run_input(["granted_lookup"], deployment=["granted_lookup"])
    )
    assert boundary["callback"] == [
        {
            "body": {
                "name": "granted_lookup",
                "args": {"value": "public marker"},
                "run": "synthetic-run-assertion",
            },
            "token": "synthetic-callback-token",
        }
    ]
    assert len(boundary["model"]) == 2
    assert any(
        "deployment result: public marker 43" in m.get("content", "")
        for m in snapshot(events)
    )
    assert "synthetic-run-assertion" not in json.dumps(events)
    assert "synthetic-callback-token" not in json.dumps(events)


@pytest.mark.asyncio
async def test_mixed_surface_and_deployment_turn_yields_without_executing_either(
    boundary,
):
    events = await run_protocol(
        run_input(
            ["computer_navigate", "granted_lookup"], deployment=["granted_lookup"]
        )
    )
    assert len([e for e in events if e["type"] == "TOOL_CALL_START"]) == 2
    assert boundary["callback"] == []
    assert len(boundary["model"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["assertion", "token"])
async def test_callback_refuses_missing_signed_scope_without_network(
    boundary, monkeypatch, missing
):
    if missing == "token":
        monkeypatch.delenv("AGENT_TOOL_TOKEN")
    body = run_input(
        ["granted_lookup"],
        deployment=["granted_lookup"],
        assertion="" if missing == "assertion" else "synthetic-run-assertion",
    )
    events = await run_protocol(body)
    assert boundary["callback"] == []
    assert "Refused." in boundary["model"][-1]["messages"][-1]["content"]
    assert "Refused." in json.dumps(snapshot(events))


@pytest.mark.asyncio
async def test_http_refusal_is_not_reported_as_tool_success(boundary):
    boundary["callback_status"] = 403
    await run_protocol(run_input(["granted_lookup"], deployment=["granted_lookup"]))
    assert "403" in boundary["model"][-1]["messages"][-1]["content"]
    assert "deployment result" not in boundary["model"][-1]["messages"][-1]["content"]


@pytest.mark.asyncio
async def test_next_request_does_not_inherit_old_tool_offer(boundary):
    body = run_input(["computer_navigate"])
    first = await run_protocol(body)
    history = snapshot(first)
    history.append({"id": "new-user", "role": "user", "content": "computer_navigate"})
    next_body = run_input([], thread=body["threadId"], messages=history)
    next_body["state"] = {"tools": [tool("computer_navigate")]}
    await run_protocol(next_body)
    assert not boundary["model"][-1].get("tools")
    assert boundary["callback"] == []


@pytest.mark.asyncio
async def test_concurrent_requests_keep_tool_ownership_and_assertions_separate(
    boundary,
):
    await asyncio.gather(
        run_protocol(run_input(["computer_navigate"])),
        run_protocol(
            run_input(
                ["granted_lookup"],
                deployment=["granted_lookup"],
                assertion="other-synthetic-run",
            )
        ),
    )
    assert len(boundary["callback"]) == 1
    assert boundary["callback"][0]["body"]["run"] == "other-synthetic-run"
    assert boundary["callback"][0]["body"]["name"] == "granted_lookup"


@pytest.mark.asyncio
async def test_undeclared_model_tool_is_refused_without_callback(boundary):
    boundary["force_call"] = "undeclared_tool"
    events = await run_protocol(
        run_input(["granted_lookup"], deployment=["granted_lookup", "undeclared_tool"]),
        allow_error=True,
    )
    assert any(
        e["type"] == "RUN_ERROR" and "not offered" in e["message"] for e in events
    )
    assert boundary["callback"] == []


@pytest.mark.asyncio
async def test_same_thread_does_not_reuse_prior_deployment_ownership(boundary):
    first_body = run_input(["granted_lookup"], deployment=["granted_lookup"])
    first = await run_protocol(first_body)
    history = snapshot(first)
    history.append({"id": "second-user", "role": "user", "content": "granted_lookup"})
    second = run_input(
        ["granted_lookup"], thread=first_body["threadId"], messages=history
    )
    second["forwardedProps"] = {}
    await run_protocol(second)
    assert len(boundary["callback"]) == 1
    assert len(boundary["model"]) == 3


def codex_events(output, response_id):
    response = {
        "id": response_id,
        "object": "response",
        "created_at": 0,
        "model": "gpt-5.5",
        "status": "completed",
        "output": output,
        "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
    }
    events = [
        {
            "type": "response.created",
            "response": {**response, "status": "in_progress", "output": []},
        }
    ]
    for index, item in enumerate(output):
        events.append(
            {
                "type": "response.output_item.added",
                "output_index": index,
                "item": {**item, "arguments": ""}
                if item["type"] == "function_call"
                else item,
            }
        )
        if item["type"] == "function_call":
            events.append(
                {
                    "type": "response.function_call_arguments.delta",
                    "output_index": index,
                    "item_id": item["id"],
                    "delta": item["arguments"],
                }
            )
        else:
            events.append(
                {
                    "type": "response.output_text.delta",
                    "output_index": index,
                    "content_index": 0,
                    "item_id": item["id"],
                    "delta": item["content"][0]["text"],
                }
            )
        events.append(
            {"type": "response.output_item.done", "output_index": index, "item": item}
        )
    events.append({"type": "response.completed", "response": response})
    return "".join("data: " + json.dumps(event) + "\n\n" for event in events).encode()


@pytest.mark.asyncio
async def test_chatgpt_plan_sdk_emits_both_surface_calls_and_consumes_results(
    boundary, monkeypatch, tmp_path
):
    auth_file = tmp_path / "synthetic-chatgpt-auth.json"
    _write_synthetic_chatgpt_store(auth_file)
    monkeypatch.setenv("CHATGPT_AUTH_FILE", str(auth_file))
    monkeypatch.setenv("BOT_MODEL", "gpt-5.5")
    captured = []

    async def send(_client, request, **_kwargs):
        assert request.url.host == "chatgpt.com"
        payload = json.loads(request.content)
        captured.append(payload)
        if len(captured) == 1:
            output = [
                {
                    "id": "fc-" + name,
                    "type": "function_call",
                    "status": "completed",
                    "call_id": "call-" + name,
                    "name": name,
                    "arguments": json.dumps({"value": "public marker"}),
                }
                for name in ["computer_navigate", "computer_run_command"]
            ]
        else:
            output = [
                {
                    "id": "msg-proof",
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Both client results: public marker 43",
                            "annotations": [],
                        }
                    ],
                }
            ]
        return httpx2.Response(
            200,
            content=codex_events(output, "resp-proof-" + str(len(captured))),
            headers={"content-type": "text/event-stream"},
            request=request,
        )

    monkeypatch.setattr(httpx2.AsyncClient, "send", send)
    names = ["computer_navigate", "computer_run_command"]
    body = run_input(names)
    first = await run_protocol(body)
    assert [t["name"] for t in captured[0]["tools"]] == names
    assert [e["toolCallName"] for e in first if e["type"] == "TOOL_CALL_START"] == names
    assert boundary["model"] == []
    assert boundary["callback"] == []
    history = snapshot(first)
    history.extend(
        {
            "id": "result-" + name,
            "role": "tool",
            "toolCallId": "call-" + name,
            "content": "client " + name + " result: public marker 43",
        }
        for name in names
    )
    second = await run_protocol(
        run_input(names, thread=body["threadId"], messages=history)
    )
    results = [
        part
        for part in captured[1]["input"]
        if part.get("type") == "function_call_output"
    ]
    assert {part["call_id"] for part in results} == {"call-" + name for name in names}
    assert all("public marker 43" in part["output"] for part in results)
    assert "Both client results: public marker 43" in json.dumps(snapshot(second))
    assert "synthetic-access" not in json.dumps(first + second)
