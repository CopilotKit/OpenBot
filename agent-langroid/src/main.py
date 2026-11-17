"""Langroid as a Bot, through `ag-ui-langroid`, which AG-UI maintains."""

import hmac
import os
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import bot_settings, openai_api

import litellm
from ag_ui_langroid import create_langroid_app
from fastapi import Request
from fastapi.responses import JSONResponse
from langroid import ChatAgent, ChatAgentConfig
from langroid.language_models import OpenAIGPTConfig

from .frontend_tools import FrontendToolsAgent

TOKEN_HEADER = "x-openbot-agent-token"


def _litellm_knows(model: str) -> bool:
    """Whether litellm's model map has this OpenAI model, and so knows what its requests may carry."""
    try:
        litellm.get_model_info(model=model, custom_llm_provider="openai")
    except Exception:
        return False
    return True


def _model_id() -> str:
    """The model id Langroid is given: through litellm, or bare to Langroid's own OpenAI client.

    Every provider but OpenAI goes through litellm, under its provider's prefix.

    An OpenAI model goes through litellm too when litellm knows it. Langroid's own client sends
    `temperature` to every model its table does not list, and its table stops at `gpt-5.2`, so
    `gpt-5.5` was refused ("'temperature' does not support 0.2 with this model"), and it sends
    `parallel_tool_calls` whatever the model, which `o3` refuses. litellm reads each model's row and
    leaves out what the model does not take (Langroid turns on litellm's `drop_params` for that).

    A model that takes function tools only on the Responses API (`gpt-5.6` and later, the `-pro`
    models) gets litellm's `responses/` route, which sends the same chat to `/v1/responses` and
    hands the answer back as a chat completion. That is decided by the model, as every Bot in the box
    decides it, so a gateway in front of OpenAI gets the Responses API for those models too.

    A model litellm does not know (one served by an OpenAI-compatible endpoint on someone's own
    hardware) stays bare, on Langroid's own OpenAI client, which needs no key for it.
    `openai/gpt-4o-mini` would be rejected by that client as an invalid model id.
    """
    settings = bot_settings("agent-langroid")
    provider = settings.provider
    model = settings.model
    if provider != "openai":
        return model if "/" in model else f"litellm/{provider}/{model}"
    if model.startswith("litellm/"):
        return model
    if openai_api(model) == "responses":
        return f"litellm/openai/responses/{model}"
    if _litellm_knows(model):
        return f"litellm/openai/{model}"
    return model


# An empty `OPENAI_API_KEY` is no key. Compose writes the keys a model choice does not use as empty
# rather than leaving them out, and Langroid reads `OPENAI_API_KEY` as its own setting: given an empty
# one it builds an OpenAI client with it, even for a model it hands to litellm, and the client refuses
# to be built. Unset, Langroid uses its placeholder and litellm reads the chosen provider's own key.
if not os.environ.get("OPENAI_API_KEY"):
    os.environ.pop("OPENAI_API_KEY", None)

# And an empty `OPENAI_BASE_URL` is no address. Compose writes it empty when the model screen chose a
# plain OpenAI key. Langroid builds its OpenAI client with no `base_url`, so the SDK reads this
# variable itself, and it falls back to `https://api.openai.com/v1` only when the variable is absent:
# given "", every request was built with no host and failed to connect. A real endpoint is left alone.
if not os.environ.get("OPENAI_BASE_URL", "").strip():
    os.environ.pop("OPENAI_BASE_URL", None)

agent = ChatAgent(
    ChatAgentConfig(
        llm=OpenAIGPTConfig(chat_model=_model_id(), parallel_tool_calls=False),
        add_to_registry=False,
        use_functions_api=True,
        use_tools=False,
        system_message="Answer the question you are asked, briefly and correctly.",
    )
)

app = create_langroid_app(FrontendToolsAgent(name="openbot", agent=agent))


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    if request.url.path != "/health":
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        if not expected or not hmac.compare_digest(offered.encode("utf-8"), expected.encode("utf-8")):
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "langroid"}
