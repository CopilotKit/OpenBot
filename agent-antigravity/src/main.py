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
"""

import hmac
import os
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import bot_settings

from ag_ui_antigravity import AntigravityAgent, create_antigravity_app
from fastapi import Request
from fastapi.responses import JSONResponse

TOKEN_HEADER = "x-openbot-agent-token"


def _model() -> str:
    """Which Gemini this deployment wants.

    `pinned_provider` beats `BOT_PROVIDER`, which is the point: see the module docstring. The
    returned model is the bare name, not `provider/model` — Antigravity takes the Gemini model id
    directly rather than through a LiteLLM-style prefix.
    """
    return bot_settings("agent-antigravity", pinned_provider="google").model


app = create_antigravity_app(
    AntigravityAgent(
        model=_model(),
        # Read from the environment by the SDK itself when absent. Named here so the failure when
        # it is missing is this Bot's, at start-up, rather than a stream that opens and dies.
        api_key=os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY"),
    ),
    path="/",
)


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
