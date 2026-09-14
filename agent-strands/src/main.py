"""AWS Strands as a Bot, through `ag_ui_strands`, which AG-UI maintains."""

import os

from ag_ui_strands import StrandsAgent, add_strands_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from strands import Agent
from strands.models.litellm import LiteLLMModel


def _model_id() -> str:
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    model = (os.environ.get("BOT_MODEL") or "gpt-4o-mini").strip()
    return model if "/" in model else f"{provider}/{model}"


app = FastAPI()

TOKEN_HEADER = "x-openbot-agent-token"


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    """Everything but `/health`, which Compose polls before any token exists."""
    if request.url.path != "/health":
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        if not expected or offered != expected:
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "strands"}


add_strands_fastapi_endpoint(
    app,
    StrandsAgent(name="openbot", agent=Agent(model=LiteLLMModel(model_id=_model_id()))),
    "/",
)
