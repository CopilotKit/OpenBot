"""Pydantic AI as a Bot.

AG-UI is built into Pydantic AI itself, as the `ag-ui` extra on `pydantic-ai-slim`, so the agent
carries its own ASGI app and there is nothing to bridge.
"""

import os

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
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    model = (os.environ.get("BOT_MODEL") or "gpt-4o-mini").strip()
    return model if model.startswith(f"{provider}:") else f"{provider}:{model}"


agent = Agent(_model_id())
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
    return {"ok": True, "harness": "pydantic-ai"}


@app.post("/")
async def run(request: Request):
    """One route, because a Bot is one endpoint.

    Pydantic AI hands back the whole streaming response, so this route holds no protocol logic of
    its own: it passes the request and the agent and returns what comes back.
    """
    return await AGUIAdapter.dispatch_request(request, agent=agent)
