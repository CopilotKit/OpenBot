"""What the engine sends the ChatGPT plan route, and how it renews the sign-in.

The plan route's rules are OpenAI's, from
https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations: every request
`store: false` and `stream: true`, no `role: "system"` input items, and none of the unsupported
fields. A run goes in through the real AG-UI endpoint, the SDK builds the real request, and a stand-in
for https://api.openai.com/v1 keeps what it was sent (and refuses it, which ends the run: what is
checked is the request). The refresh is held to
https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#refreshing-tokens.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import stat
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

UNSUPPORTED = {
    "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation",
    "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature",
    "top_logprobs", "top_p", "truncation", "user", "previous_response_id",
}


def _jwt(exp: float) -> str:
    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{part({'alg': 'none'})}.{part({'exp': int(exp)})}.sig"


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Stand:
    """The plan route and the token endpoint, on 127.0.0.1."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.refreshes: list[dict] = []
        self.bearers: list[str] = []
        self.listing_bearers: list[str] = []
        app = FastAPI()

        self.unauthorized = False
        # The account's model catalog, as `GET /v1/models` answers it; None answers 404.
        self.listing: dict | None = None

        @app.get("/v1/models")
        async def listed_models(request: Request):
            self.listing_bearers.append(request.headers.get("authorization", ""))
            if self.listing is None:
                return JSONResponse({"detail": "Not Found"}, status_code=404)
            return self.listing

        @app.post("/v1/responses")
        async def responses(request: Request):
            self.bearers.append(request.headers.get("authorization", ""))
            self.requests.append(await request.json())
            if self.unauthorized:
                # As the plan route answers a token whose sign-in was disconnected.
                return JSONResponse({"detail": "Unauthorized"}, status_code=401)
            return JSONResponse(
                {"error": {"message": "stand-in", "type": "invalid_request_error", "code": "stand_in"}},
                status_code=400,
            )

        @app.post("/api/accounts/oauth/token")
        async def token(request: Request):
            form = dict((await request.form()).items())
            self.refreshes.append(form)
            return {
                "access_token": _jwt(time.time() + 3600),
                "refresh_token": f"refresh-{len(self.refreshes) + 1}",
                "id_token": "id",
                "token_type": "Bearer",
                "expires_in": 3600,
                "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            }

        self.port = _free_port()
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        while not self.server.started:
            time.sleep(0.02)

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(5)


@pytest.fixture
def stand():
    running = Stand()
    yield running
    running.stop()


def _record(path: Path, access_exp: float) -> None:
    path.write_text(json.dumps({
        "client_id": "oaiapp_test",
        "ext_agent_host_id": "urn:uuid:00000000-0000-4000-8000-000000000000",
        "access_token": _jwt(access_exp),
        "refresh_token": "refresh-1",
        "id_token": "id",
        "scopes": ["chatgpt.tokens.use.direct", "email", "offline_access", "openid", "profile", "resource.invoke"],
    }))
    os.chmod(path, 0o600)


@pytest.fixture
def engine(tmp_path, monkeypatch, stand):
    record = tmp_path / "chatgpt-auth.json"
    _record(record, time.time() + 3600)
    monkeypatch.setenv("CHATGPT_AUTH_FILE", str(record))
    monkeypatch.setenv("CHATGPT_MODEL", "gpt-test")
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "server-token")
    import importlib

    from src import chatgpt_credentials, main

    main = importlib.reload(main)
    main.CREDENTIALS.path = record
    main.CREDENTIALS.token_url = f"{stand.base}/api/accounts/oauth/token"
    from openai import AsyncOpenAI

    main.run_config.model_provider.client = AsyncOpenAI(
        api_key=main.plan_token, base_url=f"{stand.base}/v1", max_retries=0
    )
    if hasattr(main, "PROVIDER"):
        main.PROVIDER.listing.url = f"{stand.base}/v1/models"
    return main, record


def _run(main, forwarded_props: dict | None = None) -> str:
    from fastapi.testclient import TestClient

    body = {
        "threadId": "t1",
        "runId": "r1",
        "state": {},
        "context": [],
        "forwardedProps": forwarded_props or {},
        "tools": [{
            "name": "lookup_order",
            "description": "Look an order up.",
            "parameters": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
        }],
        "messages": [
            {"id": "s1", "role": "system", "content": "You are Pat. Always end every reply with: Over."},
            {"id": "s2", "role": "system", "content": "You can use these apps for the person."},
            {"id": "u1", "role": "user", "content": "Where is order 7?"},
        ],
    }
    with TestClient(main.app) as client:
        response = client.post("/", json=body, headers={"x-openbot-agent-token": "server-token"})
        assert response.status_code == 200
        assert "RUN_ERROR" in response.text  # the stand-in refuses; the request is what is checked
        return response.text


def test_a_run_sends_what_the_plan_route_accepts(engine, stand):
    main, _ = engine
    _run(main)
    assert stand.requests, "the model was never asked"
    request = stand.requests[0]
    assert request["store"] is False
    assert request["stream"] is True
    assert not UNSUPPORTED & set(request), sorted(UNSUPPORTED & set(request))
    roles = [item.get("role") for item in request["input"] if item.get("type", "message") == "message"]
    assert "system" not in roles
    developer = [item for item in request["input"] if item.get("role") == "developer"]
    def text(item):
        content = item["content"]
        return content if isinstance(content, str) else "".join(part["text"] for part in content)

    assert [text(d) for d in developer] == [
        "You are Pat. Always end every reply with: Over.",
        "You can use these apps for the person.",
    ]
    assert request["input"].index(developer[0]) < request["input"].index(developer[1])
    assert [tool["name"] for tool in request["tools"]] == ["lookup_order"]
    assert stand.bearers[0].startswith("Bearer ") and stand.bearers[0].count(".") == 2


def test_a_run_needs_the_server_token(engine):
    main, _ = engine
    from fastapi.testclient import TestClient

    with TestClient(main.app) as client:
        assert client.post("/", json={}).status_code == 401
        assert client.get("/health").status_code == 200


def test_a_lapsing_token_is_renewed_and_the_rotated_one_saved(engine, stand):
    main, record = engine
    _record(record, time.time() + 60)  # inside the renewal window
    _run(main)
    assert stand.refreshes == [{
        "grant_type": "refresh_token",
        "client_id": "oaiapp_test",
        "refresh_token": "refresh-1",
        "resource": "https://api.openai.com/v1",
    }]
    saved = json.loads(record.read_text())
    assert saved["refresh_token"] == "refresh-2"
    assert stand.bearers[0] == f"Bearer {saved['access_token']}"
    assert stat.S_IMODE(record.stat().st_mode) == 0o600
    # A second run finds the renewed token good and does not spend the refresh token again.
    _run(main)
    assert len(stand.refreshes) == 1


def _run_error(text: str) -> dict:
    events = [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")]
    return [event for event in events if event.get("type") == "RUN_ERROR"][-1]


def test_a_sign_in_without_plan_permission_is_not_used(engine, stand):
    main, record = engine
    data = json.loads(record.read_text())
    data["scopes"] = ["openid", "profile", "email", "offline_access"]
    record.write_text(json.dumps(data))
    error = _run_error(_run(main))
    assert stand.requests == []
    assert error.get("code") == "OPENBOT_MODEL_AUTH_REQUIRED"


def test_an_earlier_versions_codex_sign_in_asks_to_sign_in_again(engine, stand):
    """The token store an earlier Desktop's Codex sign-in left, which this engine can't use: the run
    ends with the code that sends OpenBot Desktop to its AI connection to sign in again."""
    main, record = engine
    record.write_text(json.dumps({"access_token": _jwt(time.time() + 3600), "refresh_token": "r",
                                  "id_token": "i", "account_id": "acct", "expires_at": 0}))
    error = _run_error(_run(main))
    assert stand.requests == []
    assert error == {**error, "code": "OPENBOT_MODEL_AUTH_REQUIRED",
                     "message": "Sign in to ChatGPT again to keep using your plan."}


def test_a_refused_token_asks_to_sign_in_again(engine, stand):
    """OpenAI answers 401 (the person disconnected OpenBot in ChatGPT's settings)."""
    main, _ = engine
    stand.unauthorized = True
    from openai import AsyncOpenAI, DefaultAsyncHttpxClient

    main.run_config.model_provider.client = AsyncOpenAI(
        api_key=main.plan_token, base_url=f"{stand.base}/v1", max_retries=0,
        http_client=DefaultAsyncHttpxClient(event_hooks={"response": [main._note_response]}),
    )
    error = _run_error(_run(main))
    assert stand.requests, "the model was asked"
    assert error.get("code") == "OPENBOT_MODEL_AUTH_REQUIRED"


# The account's catalog as OpenAI lists it for the plan: two models for a picker, one hidden.
LISTING = {"models": [
    {"slug": "gpt-listed-a", "display_name": "Listed A", "visibility": "list", "priority": 1,
     "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}],
     "default_reasoning_level": "low"},
    {"slug": "gpt-test", "display_name": "Configured", "visibility": "list", "priority": 2},
    {"slug": "gpt-hidden", "display_name": "Hidden", "visibility": "hide"},
]}


def _picked(model: str, effort: str | None = None) -> dict:
    choice = {"model": model}
    if effort:
        choice["reasoningEffort"] = effort
    return {"openbotModel": choice}


def test_the_model_picked_in_openbot_is_the_one_asked(engine, stand, caplog):
    main, _ = engine
    stand.listing = LISTING
    with caplog.at_level("INFO", logger="agent-openai-agents"):
        _run(main, _picked("gpt-listed-a", "high"))
    sent = stand.requests[0]
    assert sent["model"] == "gpt-listed-a"
    assert sent["reasoning"]["effort"] == "high"
    assert sent["store"] is False and sent["stream"] is True
    assert stand.listing_bearers and stand.listing_bearers[0].startswith("Bearer ")
    assert "model: gpt-listed-a (picked in OpenBot), effort high" in caplog.text


def test_a_pick_the_account_does_not_list_falls_back_and_says_so(engine, stand, caplog):
    main, _ = engine
    stand.listing = LISTING
    with caplog.at_level("INFO", logger="agent-openai-agents"):
        _run(main, _picked("gpt-hidden", "high"))
    sent = stand.requests[0]
    assert sent["model"] == "gpt-test"
    assert "effort" not in (sent.get("reasoning") or {})  # the pick's effort was for the pick
    assert "model: gpt-test (configured; gpt-hidden is not offered)" in caplog.text


def test_without_a_pick_the_configured_model_is_asked(engine, stand):
    main, _ = engine
    stand.listing = LISTING
    _run(main)
    assert stand.requests[0]["model"] == "gpt-test"


def test_the_model_list_is_the_accounts_listed_models(engine, stand):
    from fastapi.testclient import TestClient

    main, _ = engine
    stand.listing = LISTING
    with TestClient(main.app) as client:
        refused = client.get("/models")
        listed = client.get("/models", headers={"x-openbot-agent-token": "server-token"})
    assert refused.status_code == 401
    assert listed.status_code == 200
    assert listed.json() == {"object": "list", "data": [
        {"id": "gpt-listed-a", "label": "Listed A", "efforts": ["low", "high"],
         "default_effort": "low", "priority": 1},
        {"id": "gpt-test", "label": "Configured", "priority": 2},
    ]}


def test_a_model_list_that_cannot_be_read_is_an_error_not_an_empty_list(engine, stand):
    from fastapi.testclient import TestClient

    main, _ = engine
    with TestClient(main.app) as client:
        response = client.get("/models", headers={"x-openbot-agent-token": "server-token"})
    assert response.status_code == 502
    assert stand.requests == []
