"""The OpenAI Agents SDK as a Bot, on a ChatGPT plan.

OpenAI's own agent SDK (openai-agents), served over AG-UI by the AG-UI project's released
integration (ag-ui-openai-agents), and paid for with the person's ChatGPT plan through OpenAI's
official Sign in with ChatGPT plan usage: the access token OpenBot Desktop's sign-in saved is sent as
the bearer to the public Responses API, https://api.openai.com/v1/responses
(https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

What the plan route asks of every request, and where each is met
(https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations):

- `store: false` and `stream: true`: `ModelSettings(store=False)` below, and the AG-UI integration
  always runs the SDK streamed (`Runner.run_streamed`).
- No `{type: "message", role: "system"}` input items: the integration turns the client's system
  messages (OpenBot sends a Bot's role and its tool guidance as system messages) into input items
  with role `system`, which this route refuses. `developer_not_system` gives them the role the route
  takes, `developer`, in the same place, through the SDK's own `call_model_input_filter`. The
  agent's own instructions go in `instructions`, which the route accepts.
- The unsupported fields (`temperature`, `top_p`, `truncation`, `max_output_tokens`, `metadata`,
  `prompt`, `previous_response_id`, `conversation`, `user`, `safety_identifier`,
  `prompt_cache_retention`, ...): the SDK sends each only when its `ModelSettings` or run names it,
  and nothing here does. No server-managed conversation is used.
- No hosted tools: the agent has none; every tool is a client tool OpenBot hands it over AG-UI.

No API key is in this engine's environment, and none is read.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from agents import (
    Agent,
    Model,
    ModelProvider,
    ModelSettings,
    OpenAIResponsesModel,
    RunConfig,
    set_tracing_disabled,
)
from agents.run_config import CallModelData, ModelInputData
from ag_ui.core import EventType, RunErrorEvent
from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint
from openai import AsyncOpenAI, DefaultAsyncHttpxClient
from openai.types.shared import Reasoning

from . import plan_models
from .chatgpt_credentials import Credentials, RESOURCE, SignInNeeded

logger = logging.getLogger("agent-openai-agents")
TOKEN_HEADER = "x-openbot-agent-token"
CREDENTIALS = Credentials(
    Path(os.environ.get("CHATGPT_AUTH_FILE") or "/root/.langchain/chatgpt-auth.json")
)
# Every model request's body, without its headers, one JSON line each, when a test asks for it.
REQUEST_LOG = (os.environ.get("OPENBOT_MODEL_REQUEST_LOG") or "").strip()
# Where the Responses requests go: OpenAI's public API, the only address the plan route serves.
# A TEST HOOK, NOTHING ELSE: the end-to-end suite points it at its recording proxy (aimock), which
# passes the bearer through to that same API and keeps each request. Desktop's Compose file never
# sets it, and nothing a person chooses can, so the plan's token goes to OpenAI and nowhere else.
API_BASE = (os.environ.get("OPENBOT_CHATGPT_API_BASE") or "").strip().rstrip("/") or RESOURCE

# Traces go to OpenAI's tracing API with an API key, which a plan has none of.
set_tracing_disabled(True)


def developer_not_system(data: CallModelData[Any]) -> ModelInputData:
    """Give the client's system messages the role the plan route accepts, where they were."""
    items = []
    for item in data.model_data.input:
        if isinstance(item, dict) and item.get("role") == "system" and item.get("type", "message") == "message":
            item = {**item, "role": "developer"}
        items.append(item)
    return ModelInputData(input=items, instructions=data.model_data.instructions)


# Whether this run's sign-in was refused: the saved one can't be used (an earlier version's, or
# signed out of), or OpenAI answered 401. One holder per run, shared with the tasks it starts.
_refused: ContextVar[dict | None] = ContextVar("chatgpt_sign_in_refused", default=None)

# What the person reads, and the code the server and OpenBot Desktop act on: Desktop opens its
# window on the AI connection, where the person signs in to ChatGPT again.
SIGN_IN_AGAIN = "Sign in to ChatGPT again to keep using your plan."
MODEL_AUTH_REQUIRED = "OPENBOT_MODEL_AUTH_REQUIRED"


def _note_refused() -> None:
    holder = _refused.get()
    if holder is not None:
        holder["refused"] = True


async def plan_token() -> str:
    """The access token for the next request; a sign-in that can't be used is noted for the run."""
    try:
        return await CREDENTIALS.access_token()
    except SignInNeeded:
        _note_refused()
        raise


async def _note_response(response: httpx.Response) -> None:
    if response.status_code == 401:
        _note_refused()


# The model and reasoning effort OpenBot's server chose for this run (`forwardedProps.openbotModel`,
# as every engine reads it), or none. The server strips any a browser sent, so it is the deployment's.
_run_choice: ContextVar[dict] = ContextVar("openbot_model", default={})


def run_choice(forwarded_props) -> dict:
    """`{"model": ..., "effort": ...}` from the run's `openbotModel`, each only when well formed."""
    props = forwarded_props if isinstance(forwarded_props, dict) else {}
    choice = props.get("openbotModel")
    if not isinstance(choice, dict):
        return {}
    model = choice.get("model")
    if not isinstance(model, str) or not model.strip():
        return {}
    effort = choice.get("reasoningEffort")
    return {
        "model": model.strip(),
        "effort": effort if isinstance(effort, str) and effort in plan_models.WIRE_EFFORTS else "",
    }


class PlanAgent(OpenAIAgentsAgent):
    """The AG-UI agent: the run's model choice, and a refused sign-in ending with the code to sign in
    again."""

    async def run_streamed(self, input):  # type: ignore[override]
        holder: dict = {}
        token = _refused.set(holder)
        choice = _run_choice.set(run_choice(input.forwarded_props))
        try:
            async for event in super().run_streamed(input):
                if getattr(event, "type", None) == EventType.RUN_ERROR and holder.get("refused"):
                    event = RunErrorEvent(
                        type=EventType.RUN_ERROR, message=SIGN_IN_AGAIN, code=MODEL_AUTH_REQUIRED
                    )
                yield event
        finally:
            _run_choice.reset(choice)
            _refused.reset(token)


async def _log_request(request: httpx.Request) -> None:
    if not REQUEST_LOG or not request.url.path.endswith("/responses"):
        return
    try:
        body = json.loads(request.content or b"{}")
    except ValueError:
        return
    with open(REQUEST_LOG, "a") as log:
        log.write(json.dumps({"at": time.time(), "body": body}) + "\n")


def _client() -> AsyncOpenAI:
    # The token is asked for on every request, so a renewed one is used as soon as it exists.
    # No retries: the plan's errors say what to do, and a usage limit retried is a wasted request
    # (https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).
    return AsyncOpenAI(
        api_key=plan_token,
        base_url=API_BASE,
        max_retries=0,
        http_client=DefaultAsyncHttpxClient(
            event_hooks={"request": [_log_request], "response": [_note_response]}
        ),
    )


class PlanModels(ModelProvider):
    """The Responses model each run answers on (`plan_models.choose`).

    The model picked in OpenBot when the account lists it; otherwise `CHATGPT_MODEL` when listed,
    else the first model the account lists for display (`GET /v1/models`, `visibility: "list"`, in
    the server's order). Every run logs which model it ran on and why.
    """

    def __init__(self) -> None:
        self.client = _client()
        self.configured = (os.environ.get("CHATGPT_MODEL") or "").strip()
        self.listing = plan_models.PlanListing(f"{API_BASE}/models", plan_token)
        self._models: dict[str, OpenAIResponsesModel] = {}

    async def resolve(self) -> tuple[OpenAIResponsesModel, str]:
        """This run's model, and the effort it asked for (empty for the model's own default)."""
        choice = _run_choice.get()
        picked = choice.get("model", "")
        name, why = plan_models.choose(picked, self.configured, await self.listing.models())
        effort = choice.get("effort", "") if name == picked else ""
        logger.info("model: %s (%s)%s", name, why, f", effort {effort}" if effort else "")
        if name not in self._models:
            self._models[name] = OpenAIResponsesModel(model=name, openai_client=self.client)
        return self._models[name], effort

    def get_model(self, model_name: str | None) -> Model:
        return _RunModel(self)


def _with_effort(args: tuple, kwargs: dict, effort: str) -> tuple[tuple, dict]:
    """The model call's arguments with the run's reasoning effort in its settings."""
    if not effort:
        return args, kwargs
    extra = ModelSettings(reasoning=Reasoning(effort=effort))
    if "model_settings" in kwargs:
        return args, {**kwargs, "model_settings": kwargs["model_settings"].resolve(extra)}
    # `system_instructions, input, model_settings, ...`, positionally, as the SDK's run loop calls it.
    return (*args[:2], args[2].resolve(extra), *args[3:]), kwargs


class _RunModel(Model):
    """The Responses model, settled per run from the run's own choice."""

    def __init__(self, provider: PlanModels) -> None:
        self.provider = provider

    async def get_response(self, *args: Any, **kwargs: Any):
        model, effort = await self.provider.resolve()
        args, kwargs = _with_effort(args, kwargs, effort)
        return await model.get_response(*args, **kwargs)

    async def stream_response(self, *args: Any, **kwargs: Any):
        model, effort = await self.provider.resolve()
        args, kwargs = _with_effort(args, kwargs, effort)
        async for event in model.stream_response(*args, **kwargs):
            yield event


agent = Agent(
    name="OpenBot",
    # The Bot's own role comes from OpenBot with every run, as a system message.
    instructions=None,
    model_settings=ModelSettings(store=False),
)
PROVIDER = PlanModels()
run_config = RunConfig(
    model_provider=PROVIDER,
    model_settings=ModelSettings(store=False),
    call_model_input_filter=developer_not_system,
    tracing_disabled=True,
)

app = FastAPI(title="OpenBot: OpenAI Agents SDK on a ChatGPT plan")


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    if request.url.path != "/health":
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        if not expected or not hmac.compare_digest(offered.encode("utf-8"), expected.encode("utf-8")):
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/models")
async def models():
    """The models the signed-in ChatGPT account offers, for OpenBot's model picker.

    `{"object": "list", "data": [{"id", "label", "efforts", "default_effort", "priority"}]}`, in the
    account's own order, the shape every plan harness answers with.
    """
    listed = await PROVIDER.listing.models()
    if listed is None:
        return JSONResponse(
            {"error": "The ChatGPT plan's model list could not be read."}, status_code=502
        )
    return {"object": "list", "data": [model.as_entry() for model in listed]}


add_openai_agents_fastapi_endpoint(
    app,
    PlanAgent(agent, run_config=run_config, name="openai-agents"),
    path="/",
)
