"""Google ADK as a Bot, through `ag_ui_adk`, which AG-UI maintains.

ADK is Gemini-first and model-agnostic after that, so the provider stays the person's choice: ADK
reads LiteLLM model strings, and OpenBot writes the one it was told.
"""

import os

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm

TOKEN_HEADER = "x-openbot-agent-token"


def _model_id() -> str:
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    model = (os.environ.get("BOT_MODEL") or "gpt-4o-mini").strip()
    return model if "/" in model else f"{provider}/{model}"


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
    return {"ok": True, "harness": "google-adk"}


add_adk_fastapi_endpoint(
    app,
    ADKAgent(
        adk_agent=Agent(
            name="openbot",
            model=LiteLlm(model=_model_id()),
            instruction="Answer the question you are asked, briefly and correctly.",
        ),
        app_name="openbot",
        user_id="openbot",
    ),
    path="/",
)
