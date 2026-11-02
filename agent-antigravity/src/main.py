"""Google Antigravity as a Bot, through `ag_ui_antigravity`, which AG-UI maintains.

GEMINI-ONLY, AND PINNED. Every other Bot in the box takes whatever provider the deployment chose:
they reach their model through LiteLLM or an equivalent, so `BOT_PROVIDER` moving them to Anthropic
or a compatible endpoint is a setting, not a break. Antigravity is not like that. Its SDK drives a
bundled Go `localharness`, and that harness wants a Gemini key wherever its base url points — the
integration's own README says so. So the provider is pinned here rather than read from the
environment, and the catalogue row says `credential: "google"` so the picker asks for the right key
instead of offering this row to a deployment that holds only an OpenAI one.

The model is still the deployment's to choose. `BOT_MODEL` names which Gemini; the pin only stops
the *provider* drifting to one the harness cannot use.

WHERE the Gemini lives is the deployment's too. The `google` row in `shared/model-providers.json`
names both variables this Bot reads — the key and the base url — and they are read from that row
rather than spelled out here, so renaming either is one edit to the file every language reads. A
base url set there sends the harness at a Gemini-compatible endpoint instead of Google's: a
gateway, a proxy that holds the real key, or a mock while someone tries the Bot out without one.
That url is the API ROOT, with no version path on it — `http://host:4141`, not
`http://host:4141/v1beta`. The harness appends `/v1beta/models/<model>:streamGenerateContent`
itself, and a url carrying the version already gets it twice and 404s, which the harness reports
as the unplaceable `agent executor error: Error 0, Message: Not found`. Measured against a logging
proxy, because that message names neither the url nor the status.
"""

import hmac
import os
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import SPEC, bot_settings

from ag_ui_antigravity import AntigravityAgent, create_antigravity_app
from fastapi import Request
from fastapi.responses import JSONResponse
from google.antigravity.models import GeminiAPIEndpoint

TOKEN_HEADER = "x-openbot-agent-token"

#: The Gemini row this Bot is pinned to. Both variable names come from it.
_GOOGLE = SPEC["providers"]["google"]


def _model() -> str:
    """Which Gemini this deployment wants.

    `pinned_provider` beats `BOT_PROVIDER`, which is the point: see the module docstring. The
    returned model is the bare name, not `provider/model` — Antigravity takes the Gemini model id
    directly rather than through a LiteLLM-style prefix.
    """
    return bot_settings("agent-antigravity", pinned_provider="google").model


def _api_key() -> str | None:
    """The key, under the name the provider row gives it.

    `GEMINI_API_KEY` is the SDK's own spelling and is taken as a second name for the same thing,
    because a deployment that already set it for another Google tool should not have to set it
    twice. Blank is not a choice: compose hands an unset variable through as an empty string.
    """
    for variable in (_GOOGLE["key_variable"], "GEMINI_API_KEY"):
        value = (os.environ.get(variable) or "").strip()
        if value:
            return value
    return None


def _agent() -> AntigravityAgent:
    """The harness, pointed at whatever Gemini this deployment runs.

    With a base url the endpoint is spelled out: `AntigravityAgent(base_url=...)` is a DIFFERENT
    and mutually exclusive path, meant for unauthenticated local servers, and it drops the key.
    `endpoint=GeminiAPIEndpoint(...)` is the one that carries both — which is what a gateway, or a
    mock in front of the Gemini API, needs.
    """
    model, api_key = _model(), _api_key()
    base_url = (os.environ.get(_GOOGLE["base_url_variable"]) or "").strip()
    if base_url:
        return AntigravityAgent(
            model=model,
            endpoint=GeminiAPIEndpoint(base_url=base_url, api_key=api_key),
        )
    # Named rather than left to the SDK's own environment read, so a missing key is this Bot's
    # failure at start-up rather than a stream that opens and dies.
    return AntigravityAgent(model=model, api_key=api_key)


app = create_antigravity_app(_agent(), path="/")


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    if request.url.path != "/health":
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        if not expected or not hmac.compare_digest(
            offered.encode("utf-8"), expected.encode("utf-8")
        ):
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "antigravity"}
