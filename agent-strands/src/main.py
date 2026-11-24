"""AWS Strands as a Bot, through `ag_ui_strands`, which AG-UI maintains."""

import hmac
import os
import sys
from contextlib import aclosing
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import bot_settings
from run_model_key import RunModelKey

from ag_ui_strands import StrandsAgent, add_strands_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from strands import Agent
from strands.models.litellm import LiteLLMModel

from src.system_prompt import RunSystemPrompt, invocation_state


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
    settings = bot_settings("agent-strands")
    provider = settings.provider
    model = settings.model
    return f"{provider}/{model}"


app = FastAPI()
# Each run's model calls carry its own gateway token, in its organization. See run_model_key.py.
app.add_middleware(RunModelKey)

TOKEN_HEADER = "x-openbot-agent-token"


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    """Everything but `/health`, which Compose polls before any token exists."""
    if request.url.path != "/health":
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        if not expected or not hmac.compare_digest(offered.encode("utf-8"), expected.encode("utf-8")):
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "strands"}


class WithoutForwardedProps(StrandsAgent):
    """None of a run's forwarded props goes on to the integration.

    The one this Bot uses, its model route, was read on the way in (`RunModelKey`); the rest are the
    server's, which nothing here reads, and whatever the browser sent. The integration takes
    `injectA2UITool` as an order: it adds a tool that calls the model again and, given a tool's
    name, takes that granted tool away from the run.
    """

    async def run(self, input_data, *, invocation_state=None):
        async with aclosing(
            super().run(
                input_data.model_copy(update={"forwarded_props": {}}),
                invocation_state=invocation_state,
            )
        ) as events:
            async for event in events:
                yield event


# The role arrives as system messages on every run and becomes that run's system prompt; see
# `system_prompt.py` for why the integration cannot be left to do it.
add_strands_fastapi_endpoint(
    app,
    WithoutForwardedProps(
        name="openbot",
        agent=Agent(model=LiteLLMModel(model_id=_model_id())),
        hooks=[RunSystemPrompt()],
    ),
    "/",
    invocation_state_provider=invocation_state,
)
