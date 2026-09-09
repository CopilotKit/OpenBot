import argparse
import ipaddress
import json
import os
import socket
import subprocess
import sys
import threading
import time
from copy import deepcopy
from pathlib import Path

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from fastapi.responses import JSONResponse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import main


class FakeMessage:
    def model_dump(self):
        return {"role": "assistant", "content": "probe reply"}


class FakeChoice:
    message = FakeMessage()


class FakeCompletion:
    choices = [FakeChoice()]


def run_input(messages):
    return {
        "threadId": "thread-1",
        "runId": "run-1",
        "state": {},
        "messages": messages,
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


@pytest.mark.parametrize(
    ("provider", "model", "expected"),
    [
        (None, None, "openai/gpt-5.5"),
        ("", "", "openai/gpt-5.5"),
        ("   ", "gpt-4o", "openai/gpt-4o"),
        ("openai", "   ", "openai/gpt-5.5"),
        ("anthropic", "claude-3-5-sonnet-latest", "anthropic/claude-3-5-sonnet-latest"),
        ("custom-provider", "custom-model", "custom-provider/custom-model"),
        ("   ", "azure/gpt-4o", "azure/gpt-4o"),
        ("anthropic", "openai/gpt-4o", "openai/gpt-4o"),
    ],
)
def test_model_normalizes_blank_provider_and_model_before_defaults(
    monkeypatch, provider, model, expected
):
    if provider is None:
        monkeypatch.delenv("BOT_PROVIDER", raising=False)
    else:
        monkeypatch.setenv("BOT_PROVIDER", provider)
    if model is None:
        monkeypatch.delenv("BOT_MODEL", raising=False)
    else:
        monkeypatch.setenv("BOT_MODEL", model)

    assert main._model() == expected


def test_crewai_endpoint_preserves_leading_bot_role_for_provider(monkeypatch):
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "test-token")
    provider_messages = []

    async def record_completion(*, model, messages, stream):
        provider_messages.append(deepcopy(messages))
        return FakeCompletion()

    monkeypatch.setattr(main, "acompletion", record_completion)

    client = TestClient(main.app)
    response = client.post(
        "/",
        headers={"x-openbot-agent-token": "test-token"},
        json=run_input(
            [
                {
                    "id": "system-1",
                    "role": "system",
                    "content": "You are Ada, a Bot-specific finance analyst.",
                },
                {
                    "id": "user-1",
                    "role": "user",
                    "content": "What should I review first?",
                },
            ]
        ),
    )

    assert response.status_code == 200
    assert provider_messages == [
        [
            {
                "role": "system",
                "content": "You are Ada, a Bot-specific finance analyst.",
            },
            {
                "role": "user",
                "content": "What should I review first?",
            },
        ]
    ]
    snapshots = [
        event["messages"]
        for event in agui_events(response.text)
        if event.get("type") == "MESSAGES_SNAPSHOT"
    ]
    assert snapshots
    assert snapshots[-1][:2] == [
        {
            "id": "system-1",
            "role": "system",
            "content": "You are Ada, a Bot-specific finance analyst.",
        },
        {
            "id": "user-1",
            "role": "user",
            "content": "What should I review first?",
        },
    ]


def test_provider_message_projection_keeps_supported_fields_without_mutating_state():
    original_messages = [
        {
            "id": "system-1",
            "role": "system",
            "content": "System instructions",
            "name": "system_name",
            "metadata": {"transport": "ag-ui"},
            "encrypted_value": "system-secret",
        },
        {
            "id": "user-1",
            "role": "user",
            "content": [
                {"type": "text", "text": "What is in this image?"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            ],
            "name": "user_name",
            "subagent_run_id": "run-user",
        },
        {
            "id": "assistant-1",
            "role": "assistant",
            "content": None,
            "name": "assistant_name",
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "lookup", "arguments": "{\"q\":\"x\"}"},
                    "metadata": {"ui": True},
                }
            ],
            "metadata": {"transport": "ag-ui"},
        },
        {
            "id": "tool-1",
            "role": "tool",
            "content": "Tool result",
            "tool_call_id": "call-1",
            "error": None,
            "metadata": {"transport": "ag-ui"},
        },
    ]
    state_messages = deepcopy(original_messages)

    projected = main._provider_messages(state_messages)

    assert projected == [
        {
            "role": "system",
            "content": "System instructions",
            "name": "system_name",
        },
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "What is in this image?"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            ],
            "name": "user_name",
        },
        {
            "role": "assistant",
            "name": "assistant_name",
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "lookup", "arguments": "{\"q\":\"x\"}"},
                }
            ],
        },
        {
            "role": "tool",
            "content": "Tool result",
            "tool_call_id": "call-1",
        },
    ]
    assert state_messages == original_messages


def isolated_environment(directory):
    directory.mkdir(parents=True, exist_ok=True)
    inherited = (
        "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "CODEX_HOME",
        "PATH", "LANG", "SYSTEMROOT", "WINDIR",
    )
    environment = {name: os.environ[name] for name in inherited if name in os.environ}
    environment.update(
        MANAGED_AGENT_TOKEN="synthetic-openbot-token",
        OPENAI_API_KEY="sk-synthetic-openbot-key",
        OTEL_SDK_DISABLED="true",
        CREWAI_TELEMETRY_DISABLED="true",
        CREWAI_STORAGE_DIR=str(directory / "crewai"),
        LITELLM_LOCAL_MODEL_COST_MAP="True",
        PYTHONPYCACHEPREFIX=str(directory / "pycache"),
        TMPDIR=str(directory),
    )
    return environment


def prohibit_external_connections(event, arguments):
    if event == "socket.getaddrinfo":
        host = arguments[0]
    elif event in ("socket.connect", "socket.sendto"):
        address = arguments[1]
        if not isinstance(address, tuple):
            raise RuntimeError("Only loopback TCP/IP is allowed in this proof")
        host = address[0]
    else:
        return
    if host != "localhost" and not ipaddress.ip_address(host).is_loopback:
        raise RuntimeError("External network access is prohibited in this proof")


def free_loopback_socket():
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    return listener


def start_loopback_app(app):
    listener = free_loopback_socket()
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]})
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert server.started, "loopback server did not start"
    return server, thread, f"http://127.0.0.1:{port}"


def stop_loopback_server(server, thread):
    server.should_exit = True
    thread.join(timeout=10)
    assert not thread.is_alive(), "loopback server did not stop"


def loopback_openai_receiver(records, strict_messages=False):
    app = FastAPI()

    @app.post("/chat/completions")
    async def chat_completions(request: Request):
        body = await request.json()
        records.append(
            {
                "model": body.get("model"),
                "messages": body.get("messages"),
                "authorization": request.headers.get("authorization"),
            }
        )
        if not body.get("model"):
            return JSONResponse({"error": {"message": "empty model rejected"}}, status_code=400)
        if strict_messages:
            allowed = {
                "system": {"role", "content", "name"},
                "user": {"role", "content", "name"},
                "assistant": {
                    "role",
                    "audio",
                    "content",
                    "function_call",
                    "name",
                    "refusal",
                    "tool_calls",
                },
                "tool": {"role", "content", "tool_call_id"},
            }
            for index, message in enumerate(body.get("messages") or []):
                role = message.get("role")
                extra = sorted(set(message) - allowed.get(role, set()))
                if extra:
                    return JSONResponse(
                        {
                            "error": {
                                "message": f"message {index} role {role} had unsupported fields: {extra}"
                            }
                        },
                        status_code=400,
                    )
                for tool_call in message.get("tool_calls") or []:
                    extra_tool_call = sorted(set(tool_call) - {"id", "type", "function"})
                    if extra_tool_call:
                        return JSONResponse(
                            {
                                "error": {
                                    "message": (
                                        f"message {index} tool call had unsupported fields: "
                                        f"{extra_tool_call}"
                                    )
                                }
                            },
                            status_code=400,
                        )
        return {
            "id": "chatcmpl-openbot-loopback",
            "object": "chat.completion",
            "created": 1,
            "model": body["model"],
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "loopback response",
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "total_tokens": 2,
            },
        }

    return app


def agui_events(response_text):
    events = []
    for line in response_text.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line.removeprefix("data: ")))
    return events


def run_litellm_loopback_proof(proof_case, output):
    sys.addaudithook(prohibit_external_connections)
    provider, model, expected_provider_model, expected_receiver_model = {
        "blank-provider": ("   ", "gpt-4o", "openai/gpt-4o", "gpt-4o"),
        "blank-model": ("openai", "   ", "openai/gpt-5.5", "gpt-5.5"),
        "strict-projection": ("openai", "gpt-4o", "openai/gpt-4o", "gpt-4o"),
    }[proof_case]
    os.environ["BOT_PROVIDER"] = provider
    os.environ["BOT_MODEL"] = model

    records = []
    receiver, receiver_thread, base_url = start_loopback_app(
        loopback_openai_receiver(records, strict_messages=proof_case == "strict-projection")
    )
    os.environ["OPENAI_BASE_URL"] = base_url
    os.environ["OPENAI_API_BASE"] = base_url
    harness, harness_thread, harness_url = start_loopback_app(main.app)
    try:
        with httpx.Client(base_url=harness_url, timeout=20, trust_env=False) as client:
            response = client.post(
                "/",
                headers={main.TOKEN_HEADER: "synthetic-openbot-token"},
                json=run_input(strict_projection_messages() if proof_case == "strict-projection" else basic_messages()),
            )
        events = agui_events(response.text)
        result = {
            "proofCase": proof_case,
            "statusCode": response.status_code,
            "normalizedModel": main._model(),
            "receiverRecords": records,
            "eventTypes": [event.get("type") for event in events],
            "messagesSnapshots": [
                event.get("messages")
                for event in events
                if event.get("type") == "MESSAGES_SNAPSHOT"
            ],
            "runFinished": any(event.get("type") == "RUN_FINISHED" for event in events),
            "runError": any(event.get("type") == "RUN_ERROR" for event in events),
            "teardown": "pending",
        }
    finally:
        stop_loopback_server(harness, harness_thread)
        stop_loopback_server(receiver, receiver_thread)

    result["teardown"] = "stopped"
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    assert result["statusCode"] == 200, result
    assert result["normalizedModel"] == expected_provider_model, result
    assert result["runFinished"], result
    assert not result["runError"], result
    assert len(records) == 1, result
    assert records[0]["model"] == expected_receiver_model, result
    assert records[0]["messages"][0] == {
        "role": "system",
        "content": "You are Ada, a Bot-specific finance analyst.",
    }, result
    if proof_case == "strict-projection":
        assert_provider_messages_are_projected(records[0]["messages"])
        assert records[0]["messages"][1] == {
            "role": "user",
            "content": [
                {"type": "text", "text": "What should I review first?"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            ],
            "name": "analyst",
        }, result
        snapshot = result["messagesSnapshots"][-1]
        assert [message["id"] for message in snapshot[:4]] == [
            "system-1",
            "user-1",
            "assistant-1",
            "tool-1",
        ], result
        assert snapshot[2]["toolCalls"][0]["id"] == "call-1", result
        assert snapshot[3]["toolCallId"] == "call-1", result
    else:
        assert records[0]["messages"][1] == {
            "role": "user",
            "content": "What should I review first?",
        }, result


def basic_messages():
    return [
        {
            "id": "system-1",
            "role": "system",
            "content": "You are Ada, a Bot-specific finance analyst.",
        },
        {
            "id": "user-1",
            "role": "user",
            "content": "What should I review first?",
        },
    ]


def strict_projection_messages():
    return [
        basic_messages()[0],
        {
            "id": "user-1",
            "role": "user",
            "content": [
                {"type": "text", "text": "What should I review first?"},
                {
                    "type": "image",
                    "source": {
                        "type": "url",
                        "value": "data:image/png;base64,AAAA",
                        "mime_type": "image/png",
                    },
                },
            ],
            "name": "analyst",
            "metadata": {"client": "ag-ui"},
            "subagent_run_id": "run-user",
        },
        {
            "id": "assistant-1",
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "lookup", "arguments": "{\"symbol\":\"ACME\"}"},
                    "metadata": {"client": "ag-ui"},
                }
            ],
            "metadata": {"client": "ag-ui"},
        },
        {
            "id": "tool-1",
            "role": "tool",
            "content": "Synthetic result",
            "tool_call_id": "call-1",
            "metadata": {"client": "ag-ui"},
            "error": None,
        },
    ]


def assert_provider_messages_are_projected(messages):
    allowed = {
        "system": {"role", "content", "name"},
        "user": {"role", "content", "name"},
        "assistant": {
            "role",
            "audio",
            "content",
            "function_call",
            "name",
            "refusal",
            "tool_calls",
        },
        "tool": {"role", "content", "tool_call_id"},
    }
    for message in messages:
        assert set(message) <= allowed[message["role"]]
        assert "id" not in message
        assert "metadata" not in message
        for tool_call in message.get("tool_calls") or []:
            assert set(tool_call) <= {"id", "type", "function"}
            assert tool_call["id"] == "call-1"


@pytest.mark.parametrize("proof_case", ["blank-provider", "blank-model", "strict-projection"])
def test_crewai_endpoint_uses_normalized_model_with_real_litellm_loopback(
    tmp_path, proof_case
):
    output = tmp_path / f"{proof_case}.json"
    completed = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--proof-case", proof_case,
            "--output", str(output),
        ],
        cwd=tmp_path,
        env=isolated_environment(tmp_path),
        text=True,
        capture_output=True,
        timeout=90,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--proof-case",
        choices=["blank-provider", "blank-model", "strict-projection"],
        required=True,
    )
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    run_litellm_loopback_proof(arguments.proof_case, arguments.output)
