"""What every Bot on AWS Strands is made of, whichever way its agent is built.

Two Bots run on Strands: `agent-strands`, a plain `strands.Agent`, and `agent-strands-harness`,
the Strands harness. They differ in how a conversation's agent is assembled and in nothing else:
the same model route, the same token check, the same system prompt and the same refusal to hand a
run's forwarded props to the integration. That part is here, and each Bot's `main.py` is what is
left: which agent, and its name.
"""

import hmac
import os
import sys
from contextlib import aclosing, asynccontextmanager
from pathlib import Path

# The other files every language in the box reads live beside this one: in the repository under
# shared/, and in an image wherever its Dockerfile copies them.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from model_providers import bot_settings
from run_model_key import RunModelKey
from strands_system_prompt import invocation_state

from ag_ui_strands import add_strands_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

TOKEN_HEADER = "x-openbot-agent-token"


def model_id(bot: str) -> str:
    """`provider/model`, which is how litellm addresses one.

    The model half is whatever the endpoint publishes, slashes included. litellm takes the first
    path component as the provider and sends the rest as the model name, so a name that already
    contains a slash still needs the chosen provider in front: `qwen/qwen3-8b` on an
    OpenAI-compatible endpoint is `openai/qwen/qwen3-8b`, and `openai/gpt-5.6-terra` is
    `openai/openai/gpt-5.6-terra`. Treating a slash as "already a provider" dropped the prefix,
    and litellm then either routed to a provider nobody configured (`LLM Provider NOT provided`)
    or sent only the second half to the endpoint.
    """
    settings = bot_settings(bot)
    return f"{settings.provider}/{settings.model}"


def create_app(harness: str) -> FastAPI:
    """The Bot's app before its agent is mounted: the run's model key, the token check, `/health`."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        """What the Bot's agent holds past a run is let go when the process stops serving."""
        yield
        for close in app.state.closing:
            await close()

    app = FastAPI(lifespan=lifespan)
    app.state.closing = []
    # Each run's model calls carry its own gateway token, in its organization. See run_model_key.py.
    app.add_middleware(RunModelKey)

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
        return {"ok": True, "harness": harness}

    return app


class WithoutForwardedProps:
    """None of a run's forwarded props goes on to the integration.

    Mixed in ahead of the integration's agent class. The one prop this Bot uses, its model route,
    was read on the way in (`RunModelKey`); the rest are the server's, which nothing here reads, and
    whatever the browser sent. The integration takes `injectA2UITool` as an order: it adds a tool
    that calls the model again and, given a tool's name, takes that granted tool away from the run.
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


def serve(app: FastAPI, agent) -> None:
    """Mount the Bot's agent at `/`.

    The role arrives as system messages on every run and becomes that run's system prompt; see
    `strands_system_prompt.py` for why the integration cannot be left to do it. The agent is built
    with `RunSystemPrompt` among its hooks, and this is the other half: what that hook reads.
    """
    add_strands_fastapi_endpoint(app, agent, "/", invocation_state_provider=invocation_state)
    # A harness keeps work between runs (background tasks, connections) and says how to end it.
    shutdown = getattr(agent, "shutdown", None)
    if callable(shutdown):
        app.state.closing.append(shutdown)
