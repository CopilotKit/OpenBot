"""LlamaIndex as a Bot.

The AG-UI support is LlamaIndex's own package, `llama-index-protocols-ag-ui`, and it hands back a
FastAPI router. Mount it and stop.
"""

import os

import litellm
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from llama_index.llms.litellm import LiteLLM
from llama_index.protocols.ag_ui.router import get_ag_ui_workflow_router

TOKEN_HEADER = "x-openbot-agent-token"


def _model_id() -> str:
    """`provider/model`, which is how litellm addresses one.

    The model half is whatever the endpoint publishes, slashes included. litellm takes the first
    path component as the provider and sends the rest as the model name, so a name that already
    contains a slash still needs the chosen provider in front: `qwen/qwen3-8b` on an
    OpenAI-compatible endpoint is `openai/qwen/qwen3-8b`, and `openai/gpt-5.6-terra` is
    `openai/openai/gpt-5.6-terra`. Treating a slash as "already a provider" dropped the prefix,
    and litellm then either routed to a provider nobody configured (`LLM Provider NOT provided`)
    or sent only the second half to the endpoint.
    """
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    model = (os.environ.get("BOT_MODEL") or "gpt-5.5").strip()
    return f"{provider}/{model}"


def _llm() -> LiteLLM:
    model = _model_id()
    if not litellm.supports_function_calling(model):
        litellm.register_model(
            {
                model: {
                    "litellm_provider": model.split("/", 1)[0],
                    "mode": "chat",
                    "supports_function_calling": True,
                }
            }
        )
    return LiteLLM(model=model, additional_kwargs={"drop_params": True})


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


app.include_router(get_ag_ui_workflow_router(llm=_llm()))
