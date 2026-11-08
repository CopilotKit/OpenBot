"""The model a run answers on: the server's choice, or one the deployment's credential offers.

Every check goes through the production AG-UI endpoint and is made on what reaches the provider:
the request body at its HTTP boundary. Providers on another host are answered by replacing the
send of the HTTP client their SDK uses (`httpx2` for OpenAI and Anthropic, `httpx` for the
harness's own read of the plan's listing); providers that take a base URL get a real local server.

The Codex backend fake follows openai/codex: the listing is `ModelsResponse` with `ModelInfo` rows
(`codex-rs/protocol/src/openai_models.rs`, with the fields of the `parses_models_response` fixture
in `codex-rs/codex-api/src/endpoint/models.rs`), and answers are Responses API events.
"""

import json
import sys
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from uuid import uuid4

import httpx
import httpx2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))

from harness_contract import fake_provider
from src import main
from test_provider_boundaries import (
    _install_loopback_socket_guard,
    _write_synthetic_chatgpt_store,
)

TOKEN = "synthetic-server-token"


@pytest.fixture(autouse=True)
def environment(monkeypatch):
    for name in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "BOT_MODEL",
        "BOT_PROVIDER",
        "CHATGPT_AUTH_FILE",
        "CHATGPT_CODEX_CLIENT_VERSION",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_BASE_URL",
        "LANGCHAIN_CODEX_ORIGINATOR",
        "OPENAI_API_BASE",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
    ]:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    from langchain_openai.chat_models import _client_utils

    # One pooled HTTP client per base URL, per process: never one from another test's loop.
    _client_utils._cached_async_httpx_client.cache_clear()
    _client_utils._cached_sync_httpx_client.cache_clear()
    yield
    _client_utils._cached_async_httpx_client.cache_clear()
    _client_utils._cached_sync_httpx_client.cache_clear()


def codex_model(slug, priority, *, visibility="list", efforts=("low", "medium", "high"), default="medium", name=None):
    """One `ModelInfo` row as the Codex backend lists it."""
    return {
        "slug": slug,
        "display_name": name or slug,
        "description": f"{slug} description",
        "default_reasoning_level": default,
        "supported_reasoning_levels": [
            {"effort": effort, "description": f"{effort} reasoning"} for effort in efforts
        ],
        "shell_type": "shell_command",
        "visibility": visibility,
        "minimal_client_version": [0, 99, 0],
        "supported_in_api": True,
        "priority": priority,
        "upgrade": None,
        "availability_nux": None,
        "base_instructions": "You are Codex.",
        "support_verbosity": False,
        "default_verbosity": None,
        "apply_patch_tool_type": None,
        "truncation_policy": {"mode": "bytes", "limit": 10_000},
        "supports_image_detail_original": False,
        "context_window": 272_000,
        "experimental_supported_tools": [],
    }


# What a ChatGPT plan lists today, in the backend's own order, which is not priority order.
PLAN_LISTING = [
    codex_model("gpt-5.4-mini", 8, efforts=("low", "medium", "high"), name="GPT-5.4 Mini"),
    codex_model(
        "gpt-5.6-sol",
        2,
        efforts=("low", "medium", "high", "xhigh", "ultra"),
        default="medium",
        name="GPT-5.6 Sol",
    ),
    codex_model("codex-auto-review", 0, visibility="hide", name="Auto review"),
    codex_model("gpt-5.6-terra", 4, efforts=("none", "low", "medium", "high"), default="low", name="GPT-5.6 Terra"),
    codex_model("gpt-legacy", 1, visibility="none"),
]


def responses_events(model, text):
    """A streamed Responses API answer, as the Codex backend and OpenAI send one."""
    item = {
        "id": "msg-proof",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }
    response = {
        "id": "resp-proof",
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
    events = [
        {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
        {"type": "response.output_item.added", "output_index": 0, "item": {**item, "content": []}},
        {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "msg-proof", "delta": text},
        {"type": "response.output_item.done", "output_index": 0, "item": item},
        {"type": "response.completed", "response": response},
    ]
    return "".join(
        f"event: {event['type']}\ndata: {json.dumps({**event, 'sequence_number': index})}\n\n"
        for index, event in enumerate(events)
    ).encode()


class CodexBackend:
    """`chatgpt.com/backend-api/codex`: the plan's listing and its answers, recorded."""

    def __init__(self, models):
        self.models = models
        self.listing_status = 200
        self.listings = []
        self.answers = []
        # The real backend refuses a model the plan does not offer; a test turns that on.
        self.refuse_unlisted = False
        # A refusal sent inside the streamed answer instead of as an HTTP status; a test sets it.
        self.stream_refusal = None

    def install(self, monkeypatch):
        listing_send = httpx.AsyncClient.send
        answer_send = httpx2.AsyncClient.send

        async def listing(client, request, **kwargs):
            if request.url.host != "chatgpt.com":
                return await listing_send(client, request, **kwargs)
            assert request.method == "GET"
            assert request.url.path == "/backend-api/codex/models"
            self.listings.append(
                {"query": dict(request.url.params), "headers": dict(request.headers)}
            )
            if self.listing_status != 200:
                return httpx.Response(self.listing_status, json={"detail": "unavailable"}, request=request)
            return httpx.Response(200, json={"models": self.models}, request=request)

        async def answer(client, request, **kwargs):
            if request.url.host != "chatgpt.com":
                return await answer_send(client, request, **kwargs)
            assert request.url.path == "/backend-api/codex/responses"
            body = json.loads(request.content)
            self.answers.append({"body": body, "headers": dict(request.headers)})
            listed = {row["slug"] for row in self.models if row["visibility"] == "list"}
            if self.refuse_unlisted and body["model"] not in listed:
                return httpx2.Response(
                    400,
                    json={
                        "detail": f"The '{body['model']}' model is not supported when using "
                        "Codex with a ChatGPT account."
                    },
                    request=request,
                )
            if self.stream_refusal:
                return httpx2.Response(
                    200,
                    content=self.stream_refusal(body["model"]),
                    headers={"content-type": "text/event-stream"},
                    request=request,
                )
            return httpx2.Response(
                200,
                content=responses_events(body["model"], f"answered on {body['model']}"),
                headers={"content-type": "text/event-stream"},
                request=request,
            )

        monkeypatch.setattr(httpx.AsyncClient, "send", listing)
        monkeypatch.setattr(httpx2.AsyncClient, "send", answer)
        return self


@pytest.fixture
def plan(monkeypatch, tmp_path):
    """A desktop signed in to a ChatGPT plan, with Compose's default `BOT_MODEL`."""
    auth_file = tmp_path / "chatgpt-auth.json"
    _write_synthetic_chatgpt_store(auth_file)
    monkeypatch.setenv("CHATGPT_AUTH_FILE", str(auth_file))
    monkeypatch.setenv("BOT_MODEL", "gpt-5.5")
    return CodexBackend(PLAN_LISTING).install(monkeypatch)


def run_body(*, model=None, tools=(), content="Say hello."):
    props = {"openbotRun": "synthetic-run-assertion"}
    if model is not None:
        props["openbotModel"] = model
    return {
        "threadId": str(uuid4()),
        "runId": str(uuid4()),
        "messages": [{"id": "user-1", "role": "user", "content": content}],
        "tools": [
            {
                "name": name,
                "description": "Public protocol proof",
                "parameters": {"type": "object", "properties": {}},
            }
            for name in tools
        ],
        "context": [],
        "state": {},
        "forwardedProps": props,
    }


async def run(body):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app), base_url="http://harness"
    ) as client:
        response = await client.post("/", json=body, headers={"x-openbot-agent-token": TOKEN})
    assert response.status_code == 200
    return [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]


def finished(events):
    assert [e["type"] for e in events if e["type"].startswith("RUN_")] == [
        "RUN_STARTED",
        "RUN_FINISHED",
    ], events
    return events


async def get(path, token=TOKEN):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app), base_url="http://harness"
    ) as client:
        headers = {"x-openbot-agent-token": token} if token else {}
        return await client.get(path, headers=headers)


# The regression: on a ChatGPT plan with Compose's default `BOT_MODEL=gpt-5.5`, every message
# failed with "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."


@pytest.mark.asyncio
async def test_a_plan_answers_on_a_model_it_lists_when_the_configured_one_is_not_offered(plan):
    events = finished(await run(run_body()))

    assert [answer["body"]["model"] for answer in plan.answers] == ["gpt-5.6-sol"], (
        "the first listed model in Codex's priority order, never one the plan does not list"
    )
    assert "answered on gpt-5.6-sol" in json.dumps(events)


@pytest.mark.asyncio
async def test_a_plan_keeps_the_configured_model_when_it_lists_it(plan, monkeypatch):
    monkeypatch.setenv("BOT_MODEL", "gpt-5.4-mini")

    finished(await run(run_body()))

    assert [answer["body"]["model"] for answer in plan.answers] == ["gpt-5.4-mini"]


@pytest.mark.asyncio
async def test_a_plan_whose_listing_cannot_be_read_keeps_the_configured_model(plan):
    plan.listing_status = 503

    finished(await run(run_body()))

    assert [answer["body"]["model"] for answer in plan.answers] == ["gpt-5.5"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("choice", "reasoning"),
    [
        ({"model": "gpt-5.6-terra", "reasoningEffort": "high"}, {"effort": "high"}),
        ({"model": "gpt-5.6-terra", "reasoningEffort": "none"}, {"effort": "none"}),
        ({"model": "gpt-5.6-terra"}, None),
    ],
)
async def test_the_servers_model_and_effort_reach_the_codex_backend(plan, choice, reasoning):
    events = finished(await run(run_body(model=choice)))

    body = plan.answers[0]["body"]
    assert body["model"] == "gpt-5.6-terra"
    assert body.get("reasoning") == reasoning
    assert "openbotModel" not in json.dumps(events), "server props never reach the snapshot"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "choice",
    [{"model": 5}, {"model": "  "}, "gpt-5.6-terra", {"reasoningEffort": "high"}],
)
async def test_a_malformed_server_choice_is_ignored(plan, monkeypatch, choice):
    monkeypatch.setenv("BOT_MODEL", "gpt-5.4-mini")

    finished(await run(run_body(model=choice)))

    assert plan.answers[0]["body"]["model"] == "gpt-5.4-mini"
    assert "reasoning" not in plan.answers[0]["body"]


@pytest.mark.asyncio
async def test_an_effort_outside_the_servers_spelling_is_not_sent(plan):
    finished(await run(run_body(model={"model": "gpt-5.6-sol", "reasoningEffort": "ultra"})))

    assert plan.answers[0]["body"]["model"] == "gpt-5.6-sol"
    assert "reasoning" not in plan.answers[0]["body"]


@pytest.mark.asyncio
async def test_a_plan_refusing_a_model_ends_the_run_with_its_reason_and_refreshes_the_listing(plan):
    plan.refuse_unlisted = True
    assert (await get("/models")).status_code == 200
    assert len(plan.listings) == 1

    events = await run(run_body(model={"model": "gpt-5.5"}))

    errors = [event for event in events if event["type"] == "RUN_ERROR"]
    assert [event["type"] for event in events][-1] == "RUN_ERROR", events
    assert "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." in (
        errors[-1]["message"]
    )
    # A refused model is not a sign-in problem: it is a refusal, which the server says in words.
    assert errors[-1].get("code") == "OPENBOT_MODEL_REFUSED"
    # The listing is read again on the next use, not after six hours.
    assert (await get("/models")).status_code == 200
    assert len(plan.listings) == 2


# The Codex backend's refusal of a tool schema, as the harness log showed it on OpenBot Desktop:
# `openai.APIError: Invalid JSON schema: regex lookaround is not supported. Found at
# $.properties.email_address.pattern.` raised from `bind_tools(model).ainvoke`. The message is the
# backend's, verbatim. The envelope is the one shape that raises that class from a stream: the
# OpenAI SDK raises `APIError` (no status, `body` = the `error` object) for a server-sent event
# whose data carries an `error` object (`openai/_streaming.py`), and reads only its `message`.
SCHEMA_REFUSAL = (
    "Invalid JSON schema: regex lookaround is not supported. Found at "
    "$.properties.email_address.pattern."
)


def schema_refused_in_stream(model):
    created = {
        "id": "resp-proof",
        "object": "response",
        "created_at": 0,
        "model": model,
        "status": "in_progress",
        "output": [],
        "parallel_tool_calls": False,
        "tool_choice": "auto",
        "tools": [],
    }
    events = [
        ("response.created", {"type": "response.created", "response": created, "sequence_number": 0}),
        ("error", {"type": "error", "error": {"message": SCHEMA_REFUSAL}, "sequence_number": 1}),
    ]
    return "".join(
        f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events
    ).encode()


@pytest.mark.asyncio
async def test_a_refusal_inside_the_streamed_answer_ends_the_run_with_a_terminal_error(plan):
    """Raised, it ended the stream with no terminal event, and the person read "Remote agent ended
    without a terminal event." in red, with nothing about why."""
    plan.stream_refusal = schema_refused_in_stream

    events = await run(run_body(model={"model": "gpt-5.6-terra"}, tools=["connect_app"]))

    types = [event["type"] for event in events]
    assert types[0] == "RUN_STARTED", events
    assert types[-1] == "RUN_ERROR", "every run ends with a terminal event"
    assert "RUN_FINISHED" not in types
    # The provider's words, marked as a refusal, so the server says it in words of its own
    # (server/src/agents/provider-refusal.ts) and keeps these for its log.
    assert events[-1]["code"] == "OPENBOT_MODEL_REFUSED"
    assert SCHEMA_REFUSAL in events[-1]["message"]
    # The tools went to the backend: this is the request the backend refused.
    assert [tool["name"] for tool in plan.answers[0]["body"]["tools"]] == ["connect_app"]


@pytest.mark.asyncio
async def test_a_run_that_fails_for_its_own_reason_still_ends_with_a_terminal_error(
    plan, monkeypatch
):
    """Not every failure is the provider's. Whatever it is, the run says so and ends."""

    async def broken():
        raise RuntimeError("synthetic harness fault")

    monkeypatch.setattr(main, "_plan_model", broken)

    events = await run(run_body())

    assert [event["type"] for event in events][-1] == "RUN_ERROR", events
    assert events[-1]["message"] == "The Bot stopped before it finished answering. Try again."
    # The harness's own words stay in its log, never in front of the person.
    assert "synthetic harness fault" not in json.dumps(events)


@pytest.mark.asyncio
async def test_models_answers_the_plans_listing_in_the_servers_shape(plan, monkeypatch):
    monkeypatch.setenv("LANGCHAIN_CODEX_ORIGINATOR", "openbot-proof")

    response = await get("/models")

    assert response.status_code == 200
    assert response.json() == {
        "object": "list",
        "data": [
            {
                "id": "gpt-5.6-sol",
                "label": "GPT-5.6 Sol",
                "efforts": ["low", "medium", "high", "xhigh"],
                "default_effort": "medium",
                "priority": 2,
            },
            {
                "id": "gpt-5.6-terra",
                "label": "GPT-5.6 Terra",
                "efforts": ["none", "low", "medium", "high"],
                "default_effort": "low",
                "priority": 4,
            },
            {
                "id": "gpt-5.4-mini",
                "label": "GPT-5.4 Mini",
                "efforts": ["low", "medium", "high"],
                "default_effort": "medium",
                "priority": 8,
            },
        ],
    }
    [request] = plan.listings
    assert request["query"] == {"client_version": "0.167.0"}
    # The same credentials the plan's answers carry (`_ChatOpenAICodex._build_headers`).
    assert request["headers"]["authorization"] == "Bearer synthetic-access"
    assert request["headers"]["chatgpt-account-id"] == "synthetic-account"
    assert request["headers"]["originator"] == "openbot-proof"


@pytest.mark.asyncio
async def test_models_leaves_out_what_a_listing_does_not_say(plan):
    bare = {
        key: value
        for key, value in codex_model("gpt-bare", 3).items()
        if key not in {"default_reasoning_level", "display_name"}
    }
    plan.models = [{**bare, "supported_reasoning_levels": []}, {**codex_model("gpt-x", 1), "priority": None}]

    response = await get("/models")

    assert response.json()["data"] == [
        {"id": "gpt-bare", "label": "gpt-bare", "priority": 3},
        {"id": "gpt-x", "label": "gpt-x", "efforts": ["low", "medium", "high"], "default_effort": "medium"},
    ]


@pytest.mark.asyncio
async def test_models_is_read_once_for_six_hours_and_keeps_the_last_good_listing(plan, monkeypatch):
    monkeypatch.setenv("CHATGPT_CODEX_CLIENT_VERSION", "0.170.1")
    first = (await get("/models")).json()
    assert (await get("/models")).json() == first
    assert len(plan.listings) == 1
    assert plan.listings[0]["query"] == {"client_version": "0.170.1"}

    from src import chatgpt_models

    chatgpt_models.PLAN_MODELS.invalidate()
    plan.listing_status = 503
    assert (await get("/models")).json() == first, "a failed refresh keeps the last good listing"
    assert len(plan.listings) == 2


@pytest.mark.asyncio
async def test_models_needs_the_server_token(plan):
    assert (await get("/models", token=None)).status_code == 401
    assert (await get("/models", token="wrong")).status_code == 401
    assert plan.listings == []


@pytest.mark.asyncio
async def test_models_is_not_found_without_a_plan(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-synthetic")

    response = await get("/models")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_models_says_so_when_the_listing_cannot_be_read(plan):
    plan.listing_status = 401

    response = await get("/models")

    assert response.status_code == 502


# Every other credential: the server's model and effort, under each provider's own field.


@contextmanager
def openai_capture(monkeypatch):
    """OpenAI's own API at api.openai.com, answering Chat Completions and Responses."""
    captured = []

    async def send(client, request, **kwargs):
        body = json.loads(request.content)
        captured.append({"url": str(request.url), "body": body})
        if request.url.path == "/v1/responses":
            return httpx2.Response(
                200,
                content=responses_events(body["model"], "openai proof"),
                headers={"content-type": "text/event-stream"},
                request=request,
            )
        chunk = {
            "id": "chatcmpl-proof",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": body["model"],
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "openai proof"}, "finish_reason": None}],
        }
        done = {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
        return httpx2.Response(
            200,
            content=f"data: {json.dumps(chunk)}\n\ndata: {json.dumps(done)}\n\ndata: [DONE]\n\n".encode(),
            headers={"content-type": "text/event-stream"},
            request=request,
        )

    monkeypatch.setattr(httpx2.AsyncClient, "send", send)
    yield captured


@pytest.mark.asyncio
@pytest.mark.parametrize("effort", ["low", None])
async def test_openai_takes_a_responses_model_on_the_responses_api_with_its_effort(monkeypatch, effort):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-synthetic")
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    choice = {"model": "gpt-6.1-terra", **({"reasoningEffort": effort} if effort else {})}
    with openai_capture(monkeypatch) as captured:
        finished(await run(run_body(model=choice, tools=["lookup"])))

    [request] = captured
    assert request["url"] == "https://api.openai.com/v1/responses"
    assert request["body"]["model"] == "gpt-6.1-terra"
    assert [tool["name"] for tool in request["body"]["tools"]] == ["lookup"]
    assert request["body"].get("reasoning") == ({"effort": effort} if effort else None)
    assert "reasoning_effort" not in request["body"]


@pytest.mark.asyncio
@pytest.mark.parametrize("effort", ["minimal", None])
async def test_openai_takes_a_chat_completions_model_with_reasoning_effort(monkeypatch, effort):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-synthetic")
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    choice = {"model": "gpt-5.5", **({"reasoningEffort": effort} if effort else {})}
    with openai_capture(monkeypatch) as captured:
        finished(await run(run_body(model=choice)))

    [request] = captured
    assert request["url"] == "https://api.openai.com/v1/chat/completions"
    assert request["body"]["model"] == "gpt-5.5"
    assert request["body"].get("reasoning_effort") == effort
    assert "reasoning" not in request["body"]


@pytest.mark.asyncio
@pytest.mark.parametrize("effort", ["high", None])
async def test_a_compatible_endpoint_gets_reasoning_effort_on_chat_completions(monkeypatch, effort):
    choice = {"model": "gemini-3.1-pro", **({"reasoningEffort": effort} if effort else {})}
    with fake_provider() as (base, bodies):
        monkeypatch.setenv("OPENAI_API_KEY", "synthetic-compatible-key")
        monkeypatch.setenv("OPENAI_BASE_URL", f"{base}/v1")
        monkeypatch.setenv("BOT_MODEL", "configured-model")
        finished(await run(run_body(model=choice)))

    [body] = bodies
    assert "messages" in body, "Chat Completions, which every compatible endpoint serves"
    assert body["model"] == "gemini-3.1-pro"
    assert body.get("reasoning_effort") == effort


@pytest.mark.asyncio
@pytest.mark.parametrize("effort", ["xhigh", "low", None])
async def test_anthropic_gets_output_config_effort(monkeypatch, effort):
    choice = {"model": "claude-opus-5-5", **({"reasoningEffort": effort} if effort else {})}
    with fake_provider() as (base, bodies):
        monkeypatch.setenv("BOT_PROVIDER", "anthropic")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-synthetic")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", base)
        finished(await run(run_body(model=choice)))

    [body] = bodies
    assert body["model"] == "claude-opus-5-5"
    assert body.get("output_config") == ({"effort": effort} if effort else None)


@pytest.mark.asyncio
@pytest.mark.parametrize("effort", ["low", None])
async def test_google_gets_its_thinking_level(monkeypatch, effort):
    _install_loopback_socket_guard()
    captured = []
    chunk = {
        "candidates": [
            {"content": {"parts": [{"text": "google proof"}], "role": "model"}, "finishReason": "STOP", "index": 0}
        ],
        "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
        "modelVersion": "gemini-3.1-pro",
    }

    class Gemini(BaseHTTPRequestHandler):
        def do_POST(self):
            captured.append(
                {"path": self.path, "body": json.loads(self.rfile.read(int(self.headers["Content-Length"])))}
            )
            streamed = ":streamGenerateContent" in self.path
            reply = (f"data: {json.dumps(chunk)}\r\n\r\n" if streamed else json.dumps(chunk)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if streamed else "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Gemini)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("BOT_PROVIDER", "google")
    monkeypatch.setenv("GOOGLE_API_KEY", "synthetic-google")
    monkeypatch.setenv("GOOGLE_GENERATIVE_AI_BASE_URL", f"http://127.0.0.1:{server.server_port}")
    choice = {"model": "gemini-3.1-pro", **({"reasoningEffort": effort} if effort else {})}
    try:
        finished(await run(run_body(model=choice)))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

    [request] = captured
    assert "/models/gemini-3.1-pro:" in request["path"]
    thinking = request["body"].get("generationConfig", {}).get("thinkingConfig")
    if effort is None:
        assert thinking is None
    else:
        # The proto field, which the API reads under either spelling; SDK releases differ.
        assert thinking in ({"thinkingLevel": "LOW"}, {"thinking_level": "LOW"})


@pytest.mark.asyncio
async def test_without_a_server_choice_the_deployment_model_answers(monkeypatch):
    with fake_provider() as (base, bodies):
        monkeypatch.setenv("OPENAI_API_KEY", "synthetic-compatible-key")
        monkeypatch.setenv("OPENAI_BASE_URL", f"{base}/v1")
        monkeypatch.setenv("BOT_MODEL", "configured-model")
        finished(await run(run_body()))

    [body] = bodies
    assert body["model"] == "configured-model"
    assert "reasoning_effort" not in body


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        # shared/model-providers.test.ts, case for case.
        ("gpt-5.6-terra", True),
        ("gpt-6", True),
        ("gpt-6.1-terra", True),
        ("gpt-5.5", False),
        (" gpt-5.6-terra", True),
        ("\tgpt-6 ", True),
        ("claude-sonnet-4-5", False),
        ("gemini-2.5-flash", False),
        ("gpt-5.6-luna", True),
        ("gpt-6-astra", True),
        ("gpt-6.1-sol", True),
        ("gpt-5-pro", True),
        ("gpt-5-pro-2025-10-06", True),
        ("gpt-5.5-pro", True),
        ("o3-pro", True),
        ("gpt-5.3-codex", True),
        ("gpt-5", False),
        ("gpt-5.4-mini", False),
        ("gpt-5.5-2026-04-23", False),
        ("o3", False),
        ("openai/gpt-5.6-terra", True),
        ("openai/gpt-5.5", False),
        ("openai/gpt-oss-20b", False),
        ("qwen/qwen3-8b", False),
    ],
)
def test_the_responses_api_rule_matches_the_shared_one(model, expected):
    assert main.requires_responses_api(model) is expected
