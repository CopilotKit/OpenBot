"""AG2 as a Bot. AG-UI is an extra in AG2's own package, so `ag2[ag-ui]` is the dependency."""

import os

from ag2 import Agent
from ag2.ag_ui import AGUIStream
from ag2.config import AnthropicConfig, OpenAIConfig
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

TOKEN_HEADER = "x-openbot-agent-token"


def _config() -> AnthropicConfig | OpenAIConfig:
    """The provider the model screen chose, which AG2 reaches through a config of its own.

    `BOT_PROVIDER` is `anthropic` for an Anthropic key and `openai` otherwise, an OpenAI-compatible
    endpoint included. Each SDK reads its own key from the environment.
    """
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    model = (os.environ.get("BOT_MODEL") or "gpt-4o-mini").strip()
    if provider == "anthropic":
        # Compose exports missing overrides as ""; the SDK only defaults an absent URL.
        base_url = (os.environ.get("ANTHROPIC_BASE_URL") or "").strip() or "https://api.anthropic.com"
        return AnthropicConfig(model=model, base_url=base_url)
    return OpenAIConfig(model=model)


agent = Agent(
    name="openbot",
    prompt="Answer the question you are asked, briefly and correctly.",
    config=_config(),
)
stream = AGUIStream(agent)

app = FastAPI()


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    if request.url.path != "/health":
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        if not expected or offered != expected:
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "ag2"}


# `build_asgi` rather than a helper: AG2 hands back a plain ASGI app to mount.
app.mount("/", stream.build_asgi())
