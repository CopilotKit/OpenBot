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


@contextmanager
def fake_provider() -> Iterator[tuple[str, list[dict]]]:
    """An OpenAI- and Anthropic-compatible model on localhost that answers "ok" and records bodies.

    Yields `(base_url, bodies)`: every request body in arrival order. Serves Chat Completions,
    Responses and Messages, streamed and not, since which one a framework uses is its own choice.
    """
    import uvicorn
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, StreamingResponse

    bodies: list[dict] = []
    app = FastAPI()

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

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
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
