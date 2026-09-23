"""Microsoft Agent Framework as a Bot, through `agent-framework-ag-ui`, which Microsoft publishes."""

import os

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
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    model = (os.environ.get("BOT_MODEL") or "gpt-4o-mini").strip()
    if provider == "anthropic":
        # Compose exports missing overrides as ""; the SDK only defaults an absent URL.
        base_url = (os.environ.get("ANTHROPIC_BASE_URL") or "").strip() or "https://api.anthropic.com"
        return AnthropicClient(model=model, base_url=base_url)
    return OpenAIChatClient(model)


agent = _client().as_agent(
    instructions="Answer the question you are asked, briefly and correctly."
)

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
    return {"ok": True, "harness": "microsoft-agent-framework"}


add_agent_framework_fastapi_endpoint(app, agent, "/")
