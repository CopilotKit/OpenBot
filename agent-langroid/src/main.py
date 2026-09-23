"""Langroid as a Bot, through `ag-ui-langroid`, which AG-UI maintains."""

import os

from ag_ui_langroid import create_langroid_app
from fastapi import Request
from fastapi.responses import JSONResponse
from langroid import ChatAgent, ChatAgentConfig
from langroid.language_models import OpenAIGPTConfig

from .frontend_tools import FrontendToolsAgent

TOKEN_HEADER = "x-openbot-agent-token"


def _model_id() -> str:
    """Langroid names an OpenAI model bare and everything else through litellm.

    `openai/gpt-4o-mini` is rejected by its OpenAI client as an invalid model id, so the prefix goes
    on only when the provider is somebody else.
    """
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    model = (os.environ.get("BOT_MODEL") or "gpt-4o-mini").strip()
    if "/" in model or provider == "openai":
        return model
    return f"litellm/{provider}/{model}"


# An empty `OPENAI_API_KEY` is no key. Compose writes the keys a model choice does not use as empty
# rather than leaving them out, and Langroid reads `OPENAI_API_KEY` as its own setting: given an empty
# one it builds an OpenAI client with it, even for a model it hands to litellm, and the client refuses
# to be built. Unset, Langroid uses its placeholder and litellm reads the chosen provider's own key.
if not os.environ.get("OPENAI_API_KEY"):
    os.environ.pop("OPENAI_API_KEY", None)

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
        if not expected or offered != expected:
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "langroid"}
