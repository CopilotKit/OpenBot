"""LlamaIndex as a Bot.

The AG-UI support is LlamaIndex's own package, `llama-index-protocols-ag-ui`, and it hands back a
FastAPI router. Mount it and stop.
"""

import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from llama_index.llms.openai import OpenAI
from llama_index.protocols.ag_ui.router import get_ag_ui_workflow_router

TOKEN_HEADER = "x-openbot-agent-token"


def _model_id() -> str:
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    model = (os.environ.get("BOT_MODEL") or "gpt-5.5").strip()
    return model if "/" in model else f"{provider}/{model}"


app = FastAPI()


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
    return {"ok": True, "harness": "llamaindex"}


app.include_router(get_ag_ui_workflow_router(llm=OpenAI(model=(os.environ.get("BOT_MODEL") or "gpt-4o-mini"))))
