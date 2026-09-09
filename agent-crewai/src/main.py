"""CrewAI as a Bot.

The third harness in the box, and the first built the way every one after it will be: the AG-UI
integration that CrewAI's own ecosystem publishes, mounted on FastAPI, with nothing of the protocol
written here. `agent-bot` and `agent-langgraph` speak AG-UI by hand because they predate the rule
that we do not write adapters. This one imports `ag_ui_crewai` and stops.

The contract with the rest of OpenBot is the same one the other Bots meet, and it is small:
serve AG-UI on a port, answer `/health`, and refuse anybody who does not carry the server's token.
"""

import os
from collections.abc import Mapping
from copy import deepcopy
from typing import Any

import ag_ui_crewai.endpoint as crewai_endpoint
from ag_ui.core import Message, Tool
from ag_ui_crewai import add_crewai_flow_fastapi_endpoint
from crewai.flow.flow import Flow, listen, start
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from litellm import acompletion

# The one header OpenBot's server sends when it calls a managed Bot. Same name the TypeScript Bots
# check, because a Bot is a Bot whatever it is written in.
TOKEN_HEADER = "x-openbot-agent-token"


def _expected_token() -> str:
    return (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()


def _model() -> str:
    """The provider and model OpenBot chose, in the form litellm wants.

    `BOT_PROVIDER` and `BOT_MODEL` are set by the shell from the model screen. litellm addresses a
    model as `provider/model`, and it reads that provider's key from the environment itself, which
    is why nothing here touches a key.
    """
    provider = (os.environ.get("BOT_PROVIDER") or "").strip() or "openai"
    model = (os.environ.get("BOT_MODEL") or "").strip() or "gpt-5.5"
    return model if "/" in model else f"{provider}/{model}"


_PROVIDER_MESSAGE_FIELDS = {
    "developer": {"role", "content", "name"},
    "system": {"role", "content", "name"},
    "user": {"role", "content", "name"},
    "assistant": {
        "role",
        "audio",
        "content",
        "function_call",
        "name",
        "refusal",
        "tool_calls",
    },
    "tool": {"role", "content", "tool_call_id"},
}


def _message_dict(message: Any) -> dict[str, Any]:
    if isinstance(message, Mapping):
        return dict(message)
    return message.model_dump()


def _strip_none(message: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in message.items() if value is not None}


def _provider_tool_calls(tool_calls: Any) -> Any:
    if not isinstance(tool_calls, list):
        return deepcopy(tool_calls)
    projected = []
    for tool_call in tool_calls:
        if not isinstance(tool_call, Mapping):
            tool_call = tool_call.model_dump()
        projected.append(
            _strip_none(
                {
                    key: deepcopy(tool_call[key])
                    for key in ("id", "type", "function")
                    if key in tool_call
                }
            )
        )
    return projected


def _provider_messages(messages: list[Any]) -> list[dict[str, Any]]:
    """Project AG-UI state messages to provider chat fields without mutating state."""
    provider_messages = []
    for message in messages:
        message_dict = _message_dict(message)
        allowed_fields = _PROVIDER_MESSAGE_FIELDS.get(message_dict.get("role"))
        if allowed_fields is None:
            continue
        projected = {
            key: deepcopy(value)
            for key, value in message_dict.items()
            if key in allowed_fields
        }
        if "tool_calls" in projected:
            projected["tool_calls"] = _provider_tool_calls(projected["tool_calls"])
        provider_messages.append(_strip_none(projected))
    return provider_messages


_prepare_crewai_inputs = crewai_endpoint.crewai_prepare_inputs


def _openbot_prepare_crewai_inputs(
    *,
    state: dict,
    messages: list[Message],
    tools: list[Tool],
    context: list[Any] | None = None,
    forwarded_props: Any = None,
):
    inputs = _prepare_crewai_inputs(
        state=state,
        messages=messages,
        tools=tools,
        context=context,
        forwarded_props=forwarded_props,
    )
    if messages and getattr(messages[0], "role", None) == "system":
        prepared_messages = inputs.get("messages")
        if isinstance(prepared_messages, list):
            leading_system = messages[0].model_dump()
            if prepared_messages[:1] != [leading_system]:
                inputs["messages"] = [leading_system, *prepared_messages]
    return inputs


crewai_endpoint.crewai_prepare_inputs = _openbot_prepare_crewai_inputs


class OpenBotFlow(Flow):
    """A crew of one, which is the right size for a Bot answering a person.

    CrewAI's own examples build multi-agent crews, and a person who wants that edits this. What
    ships has to answer the first question somebody asks it without a role, a goal and a backstory
    being invented on their behalf.
    """

    @start()
    async def answer(self):
        messages = self.state.get("messages", [])
        response = await acompletion(
            model=_model(),
            messages=_provider_messages(messages),
            stream=False,
        )
        self.state.setdefault("messages", []).append(
            response.choices[0].message.model_dump()
        )


app = FastAPI()


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    """Everything but `/health` carries the server's token.

    `/health` is exempt because Compose polls it before anything has a token to send, and a
    healthcheck that authenticates is a container that never reports healthy.
    """
    if request.url.path != "/health":
        expected = _expected_token()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        # An unset token means unconfigured, not open. A Bot that answers anybody because nobody
        # set a secret is the failure this check exists for.
        if not expected or offered != expected:
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "crewai"}


add_crewai_flow_fastapi_endpoint(app, OpenBotFlow(), "/")
