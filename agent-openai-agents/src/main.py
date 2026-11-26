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
from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint
from openai import AsyncOpenAI, DefaultAsyncHttpxClient

from .chatgpt_credentials import Credentials, RESOURCE

logger = logging.getLogger("agent-openai-agents")
TOKEN_HEADER = "x-openbot-agent-token"
CREDENTIALS = Credentials(
    Path(os.environ.get("CHATGPT_AUTH_FILE") or "/root/.langchain/chatgpt-auth.json")
)
# Every model request's body, without its headers, one JSON line each, when a test asks for it.
REQUEST_LOG = (os.environ.get("OPENBOT_MODEL_REQUEST_LOG") or "").strip()
# Where the Responses requests go: OpenAI's public API, the only address the plan route serves. A
# test points it at a recording proxy that passes the bearer through to that same API.
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
        api_key=CREDENTIALS.access_token,
        base_url=API_BASE,
        max_retries=0,
        http_client=DefaultAsyncHttpxClient(event_hooks={"request": [_log_request]}),
    )


class PlanModels(ModelProvider):
    """The Responses model the signed-in account offers.

    `CHATGPT_MODEL` names one; otherwise the first the account lists for display
    (`GET /v1/models`, `visibility: "list"`, in the server's order), asked once.
    """

    def __init__(self) -> None:
        self.client = _client()
        self.default: str | None = (os.environ.get("CHATGPT_MODEL") or "").strip() or None

    async def _account_default(self) -> str:
        if self.default:
            return self.default
        async with httpx.AsyncClient(timeout=30) as http:
            response = await http.get(
                f"{API_BASE}/models",
                headers={"Authorization": f"Bearer {await CREDENTIALS.access_token()}"},
            )
        response.raise_for_status()
        listed = [
            model.get("slug") or model.get("id")
            for model in response.json().get("models", [])
            if model.get("visibility") == "list"
        ]
        if not listed:
            raise RuntimeError("The ChatGPT account lists no model this Bot can use.")
        self.default = listed[0]
        logger.info("model: %s (first of %d the account lists)", self.default, len(listed))
        return self.default

    def get_model(self, model_name: str | None) -> Model:
        return _LazyModel(self, model_name)


class _LazyModel(Model):
    """A Responses model whose name is settled on its first call."""

    def __init__(self, provider: PlanModels, name: str | None) -> None:
        self.provider = provider
        self.name = name
        self.model: OpenAIResponsesModel | None = None

    async def _resolved(self) -> OpenAIResponsesModel:
        if self.model is None:
            name = self.name or await self.provider._account_default()
            self.model = OpenAIResponsesModel(model=name, openai_client=self.provider.client)
        return self.model

    async def get_response(self, *args: Any, **kwargs: Any):
        return await (await self._resolved()).get_response(*args, **kwargs)

    async def stream_response(self, *args: Any, **kwargs: Any):
        model = await self._resolved()
        async for event in model.stream_response(*args, **kwargs):
            yield event


agent = Agent(
    name="OpenBot",
    # The Bot's own role comes from OpenBot with every run, as a system message.
    instructions=None,
    model_settings=ModelSettings(store=False),
)
run_config = RunConfig(
    model_provider=PlanModels(),
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


add_openai_agents_fastapi_endpoint(
    app,
    OpenAIAgentsAgent(agent, run_config=run_config, name="openai-agents"),
    path="/",
)
