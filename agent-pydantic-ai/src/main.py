"""Pydantic AI as a Bot.

AG-UI is built into Pydantic AI itself, as the `ag-ui` extra on `pydantic-ai-slim`, so the agent
carries its own ASGI app and there is nothing to bridge.
"""

import hmac
import os
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import bot_settings

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic_ai import Agent
from pydantic_ai.ui.ag_ui import AGUIAdapter

TOKEN_HEADER = "x-openbot-agent-token"


def _model_id() -> str:
    """`provider:model`, which is the form Pydantic AI names a model in.

    A colon in `BOT_MODEL` names the provider only when it follows the provider's own name. Any
    other colon is part of the model's name: Ollama tags every model with one, as in `llama3.1:8b`,
    and Pydantic AI read the part before it as a provider, refused an unknown one and started no Bot.
    """
    settings = bot_settings("agent-pydantic-ai")
    provider = settings.provider
    model = settings.model
    return model if model.startswith(f"{provider}:") else f"{provider}:{model}"


def _drop_blank_base_urls() -> None:
    """Compose exports missing overrides as ""; the SDKs only default an absent URL.

    The model screen writes the endpoint it did not need as empty: `OPENAI_BASE_URL` for a plain
    OpenAI key, `ANTHROPIC_BASE_URL` for an Anthropic key. Pydantic AI builds each provider's client
    from the environment, so the empty value reached the SDK as the address and every run failed to
    connect. Taking it out lets the SDK use its own endpoint; a real one is left as it is. The same
    rule as `_normalize_openai_base_url` in `agent-langgraph-agui`.
    """
    for name in ("OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"):
        value = os.environ.get(name)
        if value is None:
            continue
        if value.strip():
            os.environ[name] = value.strip()
        else:
            os.environ.pop(name, None)


_drop_blank_base_urls()
agent = Agent(_model_id())
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
    return {"ok": True, "harness": "pydantic-ai"}


@app.post("/")
async def run(request: Request):
    """One route, because a Bot is one endpoint.

    Pydantic AI hands back the whole streaming response, so this route holds no protocol logic of
    its own: it passes the request and the agent and returns what comes back.
    """
    # This authenticated client is OpenBot's server, which owns the standing
    # role and verified learned catalog. Preserve its per-invocation prompt.
    return await AGUIAdapter.dispatch_request(
        request, agent=agent, manage_system_prompt="client"
    )
