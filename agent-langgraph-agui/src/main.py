"""LangGraph as a Bot, through the AG-UI integration rather than by hand.

OpenBot already ships `agent-langgraph`, which speaks AG-UI itself because it predates the rule
against writing adapters. This is the same framework served through `ag-ui-langgraph`, which is the
package the AG-UI project maintains, so the protocol stops being ours to keep working.
"""

import os

from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from langchain.chat_models import init_chat_model
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

TOKEN_HEADER = "x-openbot-agent-token"

# Provider names supported by LangChain's public init_chat_model contract. A colon in an opaque
# compatible model ID (for example qwen2.5:1.5b) is not a provider separator.
MODEL_PROVIDERS = {
    "anthropic",
    "anthropic_bedrock",
    "azure_ai",
    "azure_openai",
    "baseten",
    "bedrock",
    "bedrock_converse",
    "cohere",
    "deepseek",
    "fireworks",
    "google_anthropic_vertex",
    "google_genai",
    "google_vertexai",
    "groq",
    "huggingface",
    "ibm",
    "langsmith",
    "litellm",
    "meta",
    "mistralai",
    "nvidia",
    "ollama",
    "openai",
    "openrouter",
    "perplexity",
    "together",
    "upstage",
    "xai",
}


def _normalize_openai_base_url():
    base_url = os.environ.get("OPENAI_BASE_URL")
    if base_url is None:
        return
    base_url = base_url.strip()
    if base_url:
        os.environ["OPENAI_BASE_URL"] = base_url
    else:
        os.environ.pop("OPENAI_BASE_URL", None)


def _model():
    """The model this Bot thinks with, chosen by which credential the deployment gave it.

    A SIGNED-IN CHATGPT PLAN IS NOT AN API KEY, and this is the only place that difference shows up.
    A plan token is a bearer for `chatgpt.com/backend-api/codex`, and `langchain-openai` pins that
    address and refuses a caller-supplied one on purpose, so pointing `OPENAI_BASE_URL` at it and
    passing the token as a key does not work and is not meant to. The Codex chat model is the
    supported way in, and it is selected by the presence of the token rather than by another
    setting, so nothing can say "plan" while holding a key.

    A recognized `provider:model` choice keeps its provider. Otherwise the model is an opaque ID
    and the selected provider is passed separately, including when that ID contains a colon.
    """
    model = (os.environ.get("BOT_MODEL") or "gpt-4o-mini").strip()
    store = (os.environ.get("CHATGPT_AUTH_FILE") or "").strip()
    if store and os.path.exists(store):
        from pathlib import Path

        # Private and experimental, both deliberately. `langchain-openai` exports no public Codex
        # model and warns in the module that this one is unofficial. That is a maintenance cost we
        # took knowingly rather than a reason to withhold the plan, because a subscription someone
        # already pays for is the whole point of offering it on the model screen.
        from langchain_openai.chat_models.codex import (
            _ChatOpenAICodex,
            _FileChatGPTOAuthTokenProvider,
        )

        # THE STORE FILE, NOT A BARE TOKEN. An access token expires within the hour and cannot be
        # renewed; the store holds the refresh token, and this provider renews from it. A Bot given
        # only the access token works until lunchtime and then reports an auth error nobody can
        # explain.
        return _ChatOpenAICodex(
            model=model,
            token_provider=_FileChatGPTOAuthTokenProvider(path=Path(store)),
        )

    _normalize_openai_base_url()
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    prefix, separator, _ = model.partition(":")
    if separator and prefix in MODEL_PROVIDERS:
        return init_chat_model(model)
    return init_chat_model(model, model_provider=provider)


async def answer(state: MessagesState):
    return {"messages": [await _model().ainvoke(state["messages"])]}


builder = StateGraph(MessagesState)
builder.add_node("answer", answer)
builder.add_edge(START, "answer")
builder.add_edge("answer", END)
# A checkpointer, because the AG-UI integration resumes a thread by id and LangGraph refuses to
# without one. In memory rather than in Postgres: OpenBot's database is where a conversation lives,
# and two stores remembering the same thread is how they come to disagree.
graph = builder.compile(checkpointer=MemorySaver())

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
    return {"ok": True, "harness": "langgraph"}


add_langgraph_fastapi_endpoint(
    app=app,
    agent=LangGraphAgent(name="openbot", graph=graph),
    path="/",
)
