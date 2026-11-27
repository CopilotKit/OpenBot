"""What every Bot must do with the run the server sends it, checked at the model's door.

The server restores a thread from Intelligence and sends all of it in `messages` on every run,
behind two system messages: the Bot's standing role, then a summary of the tools it holds
(`runWith` in `server/src/copilot.ts`). For a remote Bot those system messages are the only way its
role reaches it. Nothing may depend on the harness remembering an earlier run: a container restart,
a second replica or an idle eviction gives it a fresh process, and that process must still answer
from the whole conversation, in its role.

A harness test sends `conversation()` to the harness's real AG-UI endpoint on a freshly imported
app, pointed at `fake_provider()`, and asserts `missing_from(the last request)` is empty. The check
is made on the HTTP body the model provider receives, so it holds whatever the AG-UI integration,
the framework and the provider SDK do in between; that is where every failure it was written for
happened (a library that read only `messages[-1]`, or stripped the first system message, or had no
branch for `role: "system"`).

Python only, because every harness that wraps a third-party integration is Python. The TypeScript
harnesses build provider messages from `input.messages` in their own code and test it there.
"""

import json
import socket
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterator

# One marker per thing the model must be shown. Distinct and unlikely, so a match is never luck.
STANDING_ROLE = "CONTRACT_STANDING_ROLE_7f3a"
GRANTED_TOOLS = "CONTRACT_GRANTED_TOOLS_7f3a"
EARLIER_QUESTION = "CONTRACT_EARLIER_QUESTION_7f3a"
EARLIER_ANSWER = "CONTRACT_EARLIER_ANSWER_7f3a"
LATEST_QUESTION = "CONTRACT_LATEST_QUESTION_7f3a"

MARKERS = {
    "the standing role": STANDING_ROLE,
    "the granted-tools summary": GRANTED_TOOLS,
    "an earlier question": EARLIER_QUESTION,
    "an earlier answer": EARLIER_ANSWER,
    "the newest question": LATEST_QUESTION,
}

BOT = "contract-bot"


def conversation(thread_id: str = "contract-thread", run_id: str = "contract-run") -> dict:
    """A run in the shape the server sends: role, holdings, then the restored thread.

    Ids follow the server's own (`standing-role:<bot>`, `granted-tools:<bot>`), because some
    integrations treat a message by its id and the check should meet the ids they will meet.
    """
    return {
        "threadId": thread_id,
        "runId": run_id,
        "state": {},
        "messages": [
            {
                "id": f"standing-role:{BOT}",
                "role": "system",
                "content": f"You are Contract Bot. {STANDING_ROLE}",
            },
            {
                "id": f"granted-tools:{BOT}",
                "role": "system",
                "content": f"You hold these tools: {GRANTED_TOOLS}",
            },
            {"id": "u1", "role": "user", "content": f"What is your favorite animal? {EARLIER_QUESTION}"},
            {"id": "a1", "role": "assistant", "content": f"Octopuses, easily. {EARLIER_ANSWER}"},
            {"id": "u2", "role": "user", "content": f"What was it again? {LATEST_QUESTION}"},
        ],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def missing_from(body: dict) -> list[str]:
    """What the model was not shown, by name; empty when the request carries all of it.

    Anywhere in the request counts, system prompt and messages alike: where a framework puts an
    instruction is its business, that it arrives at all is the contract.
    """
    text = json.dumps(body)
    return [name for name, marker in MARKERS.items() if marker not in text]


# A tool call the model made in the previous run, which the server ran between the two runs and
# now hands back with its result. AG-UI's tool call has no field for Gemini's thought signature, so
# it arrives unsigned, and Gemini 3 and later refuse an unsigned call in the current turn. See
# `shared/gemini_signatures.py`.
HANDED_BACK_TOOL = {
    "name": "look_up_order",
    "description": "Look up the status of an order by its number.",
    "parameters": {
        "type": "object",
        "properties": {"order": {"type": "string", "description": "The order number."}},
        "required": ["order"],
    },
}
GEMINI_MODEL = "gemini-3.8-flash"


def handback(thread_id: str = "handback-thread", run_id: str = "handback-run") -> dict:
    """A run carrying a tool call made in the previous run and its result, as the server sends it."""
    return {
        "threadId": thread_id,
        "runId": run_id,
        "state": {},
        "messages": [
            {"id": "u1", "role": "user", "content": "What is the status of order 42?"},
            {
                "id": "a1",
                "role": "assistant",
                "content": "",
                "toolCalls": [
                    {
                        "id": "call_handback",
                        "type": "function",
                        "function": {"name": "look_up_order", "arguments": '{"order": "42"}'},
                    }
                ],
            },
            {
                "id": "t1",
                "role": "tool",
                "toolCallId": "call_handback",
                "content": '{"status": "shipped"}',
            },
        ],
        "tools": [HANDED_BACK_TOOL],
        "context": [],
        "forwardedProps": {},
    }


def tool_calls_sent(body: dict) -> list[dict]:
    """Every tool call in a model request: Chat Completions `tool_calls` and Gemini `functionCall`
    parts, each as `{"name": ..., "signature": ...}` with the thought signature it carries, if any.
    """
    calls = []
    for message in body.get("messages") or []:
        for call in (message.get("tool_calls") or []) if isinstance(message, dict) else []:
            google = ((call.get("extra_content") or {}).get("google") or {})
            calls.append(
                {
                    "name": (call.get("function") or {}).get("name"),
                    "signature": google.get("thought_signature"),
                }
            )
    for content in body.get("contents") or []:
        for part in content.get("parts") or [] if isinstance(content, dict) else []:
            call = part.get("functionCall") or part.get("function_call")
            if call:
                calls.append(
                    {
                        "name": call.get("name"),
                        "signature": part.get("thoughtSignature") or part.get("thought_signature"),
                    }
                )
    return calls


def check_handback_signed(bodies: list[dict]) -> None:
    """The model was sent the handed-back call as a call, and the call carries a signature."""
    assert bodies, "the model was never called"
    calls = [call for call in tool_calls_sent(bodies[-1]) if call["name"] == "look_up_order"]
    assert calls, f"the handed-back call never reached the model as a call: {bodies[-1]}"
    assert all(call["signature"] for call in calls), f"an unsigned call reached Gemini: {calls}"


def gemini_environment(base: str, model: str = GEMINI_MODEL) -> dict[str, str]:
    """Gemini's own API at `base`, the way `BOT_PROVIDER=google` configures one.

    `GOOGLE_GENERATIVE_AI_BASE_URL` is the `google` row's variable; `GEMINI_API_BASE` and
    `GOOGLE_GEMINI_BASE_URL` are LiteLLM's and google-genai's own names for the same address, set
    here so whichever client a framework builds is pointed at the fake.
    """
    return {
        "BOT_PROVIDER": "google",
        "BOT_MODEL": model,
        "GOOGLE_API_KEY": "contract-key",
        "GOOGLE_GENERATIVE_AI_BASE_URL": base,
        "GEMINI_API_BASE": base,
        "GOOGLE_GEMINI_BASE_URL": base,
        "OPENAI_API_KEY": "",
        "OPENAI_BASE_URL": "",
        "ANTHROPIC_API_KEY": "",
    }


def gemini_gateway_environment(base: str, model: str = GEMINI_MODEL) -> dict[str, str]:
    """A Gemini model on an OpenAI-compatible address: OpenBot's model gateway at `base`.

    Google's own compatible endpoint is signed by its host, which a test cannot serve; the gateway's
    path is signed by the same rule for a Gemini model.
    """
    return {
        "BOT_PROVIDER": "",
        "BOT_MODEL": model,
        "OPENAI_API_KEY": "contract-key",
        "OPENAI_BASE_URL": f"{base}/api/model-provider/v1",
        "ANTHROPIC_API_KEY": "",
        "GOOGLE_API_KEY": "",
    }


def openai_environment(base: str, model: str = "contract-model") -> dict[str, str]:
    """An OpenAI-compatible endpoint at `base`, the way the setup screen configures one."""
    return {
        "BOT_PROVIDER": "",
        "BOT_MODEL": model,
        "OPENAI_API_KEY": "contract-key",
        "OPENAI_BASE_URL": f"{base}/v1",
        "ANTHROPIC_API_KEY": "",
    }


def anthropic_environment(base: str, model: str = "claude-sonnet-5-5") -> dict[str, str]:
    return {
        "BOT_PROVIDER": "anthropic",
        "BOT_MODEL": model,
        "ANTHROPIC_API_KEY": "contract-key",
        "ANTHROPIC_BASE_URL": base,
        "OPENAI_API_KEY": "",
        "OPENAI_BASE_URL": "",
    }


# OpenBot's model gateway, as a harness it runs reaches it: the deployment's gateway token in the
# environment, and the token the server minted for one run, in its organization, on the run.
DEPLOYMENT_KEY = "contract-deployment-gateway-token"
RUN_KEY = "obgw_contract-run-token"


def gateway_environment(wire: str):
    """An environment function, like `openai_environment`, for the gateway's `wire` at `base`."""

    def environment(base: str, model: str = "contract-model") -> dict[str, str]:
        gateway = f"{base}/api/model-provider"
        if wire == "anthropic":
            return {
                "BOT_PROVIDER": "anthropic",
                "BOT_MODEL": "claude-sonnet-5-5",
                "ANTHROPIC_API_KEY": DEPLOYMENT_KEY,
                "ANTHROPIC_BASE_URL": f"{gateway}/anthropic",
                "OPENAI_API_KEY": "",
                "OPENAI_BASE_URL": "",
            }
        return {
            "BOT_PROVIDER": "",
            "BOT_MODEL": model,
            "OPENAI_API_KEY": DEPLOYMENT_KEY,
            "OPENAI_BASE_URL": f"{gateway}/v1",
            "ANTHROPIC_API_KEY": "",
        }

    environment.__name__ = f"gateway_{wire}_environment"
    return environment


def with_run_key(body: dict, wire: str) -> dict:
    """`body` as the server sends a harness it runs: with the run's own gateway token."""
    return {
        **body,
        "forwardedProps": {
            **(body.get("forwardedProps") or {}),
            "openbotModelRoute": {"via": wire, "token": RUN_KEY},
            "openbotOrganization": "contract-organization",
        },
    }


def check_run_keys(keys: list[str], ran_with_token: int, bodies: list[dict]) -> None:
    """The first `ran_with_token` model requests carried the run's token, the rest the environment's.

    And neither the token nor the organization reached the model in a request body.
    """
    assert ran_with_token > 0, "the run with a token never reached the model"
    assert set(keys[:ran_with_token]) == {RUN_KEY}, keys
    assert keys[ran_with_token:] and set(keys[ran_with_token:]) == {DEPLOYMENT_KEY}, keys
    text = json.dumps(bodies)
    assert RUN_KEY not in text and "contract-organization" not in text


def check_gateway_keys(app_for, wire: str, *, path: str = "/", token: str = "contract-token") -> None:
    """A harness calls the gateway with its run's token, and with the environment's key without one.

    `app_for(environment)` sets `environment` (a dict) for the harness and answers its app on a
    fresh import. Two runs on one process, as the server sends them: the first with a token, the
    second without.
    """
    from fastapi.testclient import TestClient

    keys: list[str] = []
    with fake_provider(keys) as (base, bodies):
        with TestClient(app_for(gateway_environment(wire)(base))) as client:
            # What a framework asks at start (a model listing) is no run's, and keeps its key.
            started = len(keys)
            ran_with_token = 0
            runs = (
                with_run_key(conversation(), wire),
                conversation(thread_id="contract-thread-2", run_id="contract-run-2"),
            )
            for body in runs:
                response = client.post(path, json=body, headers={"x-openbot-agent-token": token})
                assert response.status_code == 200, response.text
                types = [e["type"] for e in run_events(response.text)]
                assert "RUN_FINISHED" in types, response.text
                if not ran_with_token:
                    ran_with_token = len(keys) - started
    check_run_keys(keys[started:], ran_with_token, bodies)


def handback_bodies(app_for, environment, *, path: str = "/", token: str = "contract-token"):
    """The model requests a harness sends for `handback()`, on a fresh app in `environment`.

    `app_for(environment)` sets `environment` (a dict) for the harness and answers its app on a
    fresh import, as for `check_gateway_keys`. `environment(base)` is an environment function such
    as `gemini_environment`.
    """
    from fastapi.testclient import TestClient

    with fake_provider() as (base, bodies):
        with TestClient(app_for(environment(base))) as client:
            response = client.post(path, json=handback(), headers={"x-openbot-agent-token": token})
    assert response.status_code == 200, response.text
    types = [e["type"] for e in run_events(response.text) if e["type"].startswith("RUN_")]
    assert types == ["RUN_STARTED", "RUN_FINISHED"], response.text
    return bodies


@contextmanager
def fake_provider(keys: list[str] | None = None) -> Iterator[tuple[str, list[dict]]]:
    """An OpenAI-, Anthropic- and Gemini-compatible model on localhost that answers "ok" and records
    bodies.

    Yields `(base_url, bodies)`: every request body in arrival order. Serves Chat Completions,
    Responses, Messages and Gemini's generateContent, streamed and not, since which one a framework
    uses is its own choice.
    Given `keys`, also writes down the key each request presented, as OpenAI's SDK sends it
    (`Authorization: Bearer`) or Anthropic's (`x-api-key`).
    """
    import uvicorn
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, StreamingResponse

    bodies: list[dict] = []
    app = FastAPI()

    if keys is not None:

        @app.middleware("http")
        async def presented(request: Request, call_next):
            bearer = request.headers.get("authorization", "")
            keys.append(
                bearer[len("Bearer ") :]
                if bearer.startswith("Bearer ")
                else request.headers.get("x-api-key", "")
            )
            return await call_next(request)

    def sse(lines):
        async def stream():
            for line in lines:
                yield line

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        body = await request.json()
        bodies.append(body)
        model = body.get("model", "contract-model")
        if not body.get("stream"):
            return JSONResponse(
                {
                    "id": "c",
                    "object": "chat.completion",
                    "created": 0,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": "ok"},
                        }
                    ],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
            )
        chunk = {
            "id": "c",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": model,
            "choices": [
                {"index": 0, "delta": {"role": "assistant", "content": "ok"}, "finish_reason": None}
            ],
        }
        done = {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
        return sse(
            [f"data: {json.dumps(chunk)}\n\n", f"data: {json.dumps(done)}\n\n", "data: [DONE]\n\n"]
        )

    @app.post("/v1/responses")
    async def responses(request: Request):
        body = await request.json()
        bodies.append(body)
        model = body.get("model", "contract-model")
        item = {
            "id": "msg",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": "ok", "annotations": []}],
        }
        response = {
            "id": "resp",
            "object": "response",
            "created_at": 0,
            "model": model,
            "status": "completed",
            "output": [item],
            "parallel_tool_calls": False,
            "tool_choice": "auto",
            "tools": [],
            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
        }
        if not body.get("stream"):
            return JSONResponse(response)
        events = [
            {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
            {"type": "response.output_item.added", "output_index": 0, "item": {**item, "content": []}},
            {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "msg", "delta": "ok"},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": response},
        ]
        return sse(
            [
                f"event: {event['type']}\ndata: {json.dumps({**event, 'sequence_number': index})}\n\n"
                for index, event in enumerate(events)
            ]
        )

    @app.post("/v1/messages")
    async def messages(request: Request):
        body = await request.json()
        bodies.append(body)
        message = {
            "id": "msg",
            "type": "message",
            "role": "assistant",
            "model": body.get("model", "claude"),
            "stop_sequence": None,
        }
        if not body.get("stream"):
            return JSONResponse(
                {
                    **message,
                    "content": [{"type": "text", "text": "ok"}],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                }
            )
        events = [
            ("message_start", {"type": "message_start", "message": {**message, "content": [], "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        return sse([f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events])

    @app.post("/{rest:path}")
    async def gemini(rest: str, request: Request):
        """Gemini's own API: `.../models/<model>:generateContent`, or `:streamGenerateContent`."""
        if not rest.endswith((":generateContent", ":streamGenerateContent")):
            return JSONResponse({"error": {"code": 404, "message": rest}}, status_code=404)
        body = await request.json()
        bodies.append(body)
        answer = {
            "candidates": [
                {
                    "content": {"role": "model", "parts": [{"text": "ok"}]},
                    "finishReason": "STOP",
                    "index": 0,
                }
            ],
            "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
            "modelVersion": rest.rsplit("/", 1)[-1].split(":", 1)[0],
        }
        if rest.endswith(":generateContent"):
            return JSONResponse(answer)
        if request.query_params.get("alt") == "sse":
            return sse([f"data: {json.dumps(answer)}\r\n\r\n"])
        return JSONResponse([answer])

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    async def served(scope, receive, send):
        # Also at OpenBot's model gateway addresses (`gateway_environment`), as the gateway serves
        # each wire: `/api/model-provider/v1/...` and `/api/model-provider/anthropic/v1/...`.
        path = scope.get("path", "")
        for prefix in ("/api/model-provider/anthropic", "/api/model-provider"):
            if path.startswith(prefix + "/"):
                scope = {key: value for key, value in scope.items() if key != "raw_path"}
                scope["path"] = path[len(prefix) :]
                break
        await app(scope, receive, send)

    server = uvicorn.Server(uvicorn.Config(served, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    try:
        yield f"http://127.0.0.1:{port}", bodies
    finally:
        server.should_exit = True
        thread.join(timeout=10)


def run_events(response_text: str) -> list[dict[str, Any]]:
    """The AG-UI events in an SSE response body, for asserting the run finished cleanly."""
    events = []
    for line in response_text.splitlines():
        if line.startswith("data:"):
            payload = line[len("data:"):].strip()
            if payload:
                try:
                    events.append(json.loads(payload))
                except json.JSONDecodeError:
                    pass
    return events
