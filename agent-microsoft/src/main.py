"""Microsoft Agent Framework as a Bot, through `agent-framework-ag-ui`, which Microsoft publishes."""

import hmac
import os
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import bot_settings

from agent_framework.anthropic import AnthropicClient
from agent_framework.openai import OpenAIChatClient
from agent_framework_ag_ui import add_agent_framework_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

TOKEN_HEADER = "x-openbot-agent-token"


def _client() -> AnthropicClient | OpenAIChatClient:
    """The provider the model screen chose, through Agent Framework's own client for it.

    `BOT_PROVIDER` is `anthropic` for an Anthropic key and `openai` otherwise, an OpenAI-compatible
    endpoint included. Each client reads its own key from the environment.
    """
    settings = bot_settings("agent-microsoft")
    provider = settings.provider
    model = settings.model
    if provider == "anthropic":
        # Compose exports missing overrides as ""; the SDK only defaults an absent URL.
        base_url = (os.environ.get("ANTHROPIC_BASE_URL") or "").strip() or "https://api.anthropic.com"
        return AnthropicClient(model=model, base_url=base_url)
    # The same "" for OPENAI_BASE_URL, which Compose writes whenever the model screen chose a plain
    # OpenAI key. The SDK only defaults an absent URL; given "", every request fails to connect.
    base_url = (os.environ.get("OPENAI_BASE_URL") or "").strip() or "https://api.openai.com/v1"
    return OpenAIChatClient(model, base_url=base_url)


agent = _client().as_agent(
    instructions="Answer the question you are asked, briefly and correctly."
)

app = FastAPI()


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    if request.url.path != "/health":
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        if not expected or not hmac.compare_digest(offered.encode("utf-8"), expected.encode("utf-8")):
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "microsoft-agent-framework"}


add_agent_framework_fastapi_endpoint(app, agent, "/")
