"""LangGraph as a Bot, through the AG-UI integration rather than by hand.

OpenBot already ships `agent-langgraph`, which speaks AG-UI itself because it predates the rule
against writing adapters. This is the same framework served through `ag-ui-langgraph`, which is the
package the AG-UI project maintains, so the protocol stops being ours to keep working.
"""

import hmac
import os
import re
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import bot_settings

from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from langchain.chat_models import init_chat_model
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import START, MessagesState, StateGraph

from . import chatgpt_models
from .tool_runtime import (
    ToolAwareAgent,
    billing_refusal,
    bind_tools,
    current_tools,
    execute_tools,
    model_messages,
    next_step,
    provider_message,
    provider_refusal,
)

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

OPENBOT_PROVIDER_ALIASES = {
    "google": "google_genai",
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


def _google_genai_kwargs(provider: str):
    if provider != "google_genai":
        return {}
    base_url = (os.environ.get("GOOGLE_GENERATIVE_AI_BASE_URL") or "").strip()
    if not base_url:
        return {}
    return {"base_url": base_url}


def _resolve_provider(provider: str):
    return OPENBOT_PROVIDER_ALIASES.get(provider, provider)


# `requiresResponsesApi` in shared/model-providers.ts, the rule every Bot in the box decides by:
# `gpt-5.6-*` and every `gpt-6*` take function tools only on the Responses API, and the `-pro` and
# `-codex` models are not served on Chat Completions at all. OpenAI's own words: "GPT-6 Astra,
# GPT-6.1 Sol, and GPT-6.1 Terra support Chat Completions, but tool calling requires Responses."
_RESPONSES_API_MODEL = re.compile(
    r"^gpt-5\.[6-9]|^gpt-[6-9]|^(?:gpt-[\d.]+|o\d+)-pro\b|^gpt-[\d.]+-codex\b"
)

# The efforts each integration takes, as its own field declares them: `reasoning_effort` (alias
# `effort`) in langchain-anthropic, `reasoning_effort` (alias `thinking_level`) in
# langchain-google-genai.
ANTHROPIC_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
GOOGLE_EFFORTS = frozenset({"minimal", "low", "medium", "high"})


def requires_responses_api(model: str) -> bool:
    """Whether this OpenAI model has to be driven through the Responses API.

    A gateway's namespaced name (`openai/gpt-5.6-terra`) is the model it names.
    """
    return bool(_RESPONSES_API_MODEL.search(model.strip().split("/")[-1]))


def _provider_kwargs(provider: str, model: str, effort: str):
    """What this provider's integration is given beyond the model: its API, and the run's effort.

    An effort is sent only when the run carries one, under the field that provider reads, so a run
    without one gets the model's own default.

    - OpenAI itself (no `OPENAI_BASE_URL`): the Responses API for a model that takes tools only
      there, with `reasoning.effort`; Chat Completions otherwise, with `reasoning_effort`.
    - Any other OpenAI-compatible endpoint: `reasoning_effort`, on whichever API the integration
      picks. Most serve only Chat Completions (Gemini's and xAI's compatible endpoints), and the
      integration moves `reasoning_effort` to `reasoning.effort` itself when it picks Responses.
    - Anthropic: `output_config.effort`, through langchain-anthropic's `effort`.
    - Google: `thinkingConfig.thinkingLevel`, through langchain-google-genai's `thinking_level`.
    """
    if provider == "openai":
        if not os.environ.get("OPENAI_BASE_URL") and requires_responses_api(model):
            return {
                "use_responses_api": True,
                **({"reasoning": {"effort": effort}} if effort else {}),
            }
        return {"reasoning_effort": effort} if effort else {}
    if provider == "anthropic" and effort in ANTHROPIC_EFFORTS:
        return {"effort": effort}
    if provider == "google_genai" and effort in GOOGLE_EFFORTS:
        return {"thinking_level": effort}
    return {}


def _chatgpt_auth_file(store: str) -> Path:
    path = Path(store)
    if not path.exists():
        raise FileNotFoundError(f"CHATGPT_AUTH_FILE points to a missing file: {path}")
    if path.is_dir():
        raise IsADirectoryError(
            f"CHATGPT_AUTH_FILE must point to a file, not a directory: {path}"
        )
    if not os.access(path, os.R_OK):
        raise PermissionError(f"CHATGPT_AUTH_FILE is not readable: {path}")
    with path.open("rb"):
        pass
    return path


def _model(plan_models=None):
    """The model this Bot thinks with, chosen by which credential the deployment gave it.

    THE SERVER CHOOSES FIRST. A run that carries `openbotModel` (`current_tools().model` and
    `.effort`) answers on that model, at that effort, on whichever credential the deployment has;
    the server only sends a model that credential offers. A run without one answers on the
    deployment's configuration below, as every run did before the server chose.

    A SIGNED-IN CHATGPT PLAN IS NOT AN API KEY, and this is the only place that difference shows up.
    A plan token is a bearer for `chatgpt.com/backend-api/codex`, and `langchain-openai` pins that
    address and refuses a caller-supplied one on purpose, so pointing `OPENAI_BASE_URL` at it and
    passing the token as a key does not work and is not meant to. The Codex chat model is the
    supported way in, and it is selected by the presence of the token rather than by another
    setting, so nothing can say "plan" while holding a key.

    A PLAN ANSWERS ONLY ON A MODEL IT OFFERS. The configured model is used on a plan only when the
    plan's own listing (`plan_models`, see `chatgpt_models`) has it; otherwise the plan's default,
    the first model it lists. `BOT_MODEL` defaults to `gpt-5.5` in Compose, and a plan that did not
    offer it refused every message. With no listing to go by, the configured model, as before.

    A recognized `provider:model` choice keeps its provider. Otherwise the model is an opaque ID
    and the selected provider is passed separately, including when that ID contains a colon.
    """
    run = current_tools()
    configured_model = os.environ.get("BOT_MODEL")
    store = (os.environ.get("CHATGPT_AUTH_FILE") or "").strip()
    if store:
        # A signed-in ChatGPT plan ignores BOT_PROVIDER, retaining this Bot's file model unless
        # BOT_MODEL overrides it. Other providers use the fully resolved settings below.
        file_row = bot_settings("agent-langgraph-agui", {})
        configured = (configured_model or "").strip() or file_row.model
        model = run.model or chatgpt_models.plan_model(configured, plan_models)
        store_path = _chatgpt_auth_file(store)
        # Private and experimental, both deliberately. `langchain-openai` exports no public Codex
        # model and warns in the module that this one is unofficial. That is a maintenance cost we
        # took knowingly rather than a reason to withhold the plan, because a subscription someone
        # already pays for is the whole point of offering it on the model screen.
        from langchain_openai.chat_models.codex import _ChatOpenAICodex

        from .chatgpt_store import ChatGptTokenStore

        # THE STORE FILE, NOT A BARE TOKEN. An access token expires within the hour and cannot be
        # renewed; the store holds the refresh token, and this provider renews from it. A Bot given
        # only the access token works until lunchtime and then reports an auth error nobody can
        # explain.
        return _ChatOpenAICodex(
            model=model,
            token_provider=ChatGptTokenStore(path=store_path),
            # The Codex backend is the Responses API, so `reasoning.effort`; `_ChatOpenAICodex`
            # inherits `ChatOpenAI.reasoning` and sends it as it is.
            **({"reasoning": {"effort": run.effort}} if run.effort else {}),
        )

    _normalize_openai_base_url()
    settings = bot_settings("agent-langgraph-agui")
    if settings.provider == "google_genai":
        # LangChain's provider spelling is also an existing BOT_PROVIDER choice. Resolve its
        # defaults through the spec's Google row before mapping back to the SDK spelling.
        settings = bot_settings(
            "agent-langgraph-agui", {**os.environ, "BOT_PROVIDER": "google"}
        )
    provider = _resolve_provider(settings.provider)
    model = run.model or settings.model
    prefix, separator, named = model.partition(":")
    if separator and prefix in MODEL_PROVIDERS:
        return init_chat_model(
            model,
            **_google_genai_kwargs(prefix),
            **_provider_kwargs(prefix, named, run.effort),
        )
    return init_chat_model(
        model,
        model_provider=provider,
        **_google_genai_kwargs(provider),
        **_provider_kwargs(provider, model, run.effort),
    )


async def _plan_model():
    """`_model`, given the plan's listing when it has to choose a plan's model by itself."""
    store = (os.environ.get("CHATGPT_AUTH_FILE") or "").strip()
    if not store or current_tools().model:
        return _model()
    from .chatgpt_store import ChatGptTokenStore

    offered = await chatgpt_models.PLAN_MODELS.models(
        ChatGptTokenStore(path=_chatgpt_auth_file(store))
    )
    return _model(plan_models=offered)


def _system_turns_first(messages):
    """Every system message ahead of the conversation, in the order it was given.

    ANTHROPIC TAKES ONE SYSTEM PROMPT, AT THE TOP. `langchain-anthropic` joins system messages that
    follow one another into it, and refuses one that comes after a conversation turn: "Received
    multiple non-consecutive system messages." A skill somebody picked used to arrive here as a
    system turn just ahead of their message, and failed every later run in that conversation on
    Anthropic before the model was asked. A skill now reaches the model as a labelled conversation
    entry (`model_messages`), but the server's quoted personal memory does too, ahead of the
    standing role, so the server's own instructions can still follow a conversation turn.

    Moved rather than merged, because the integration already joins the ones that are adjacent.
    Only for Anthropic: OpenAI takes a system turn anywhere, and `langchain-google-genai` already
    gathers every system message into Gemini's one system instruction by itself.
    """
    from langchain_core.messages import SystemMessage, convert_to_messages

    messages = convert_to_messages(messages)
    return [
        *(message for message in messages if isinstance(message, SystemMessage)),
        *(message for message in messages if not isinstance(message, SystemMessage)),
    ]


def _wants_system_turns_first(model) -> bool:
    """
    Anthropic is the provider that refuses non-consecutive system turns, and it is asked for by
    class rather than by `BOT_PROVIDER` because `BOT_MODEL` can name a provider on its own.

    The import is here rather than at the top of the file because this module is imported to read
    a deployment's provider configuration in places that install no provider package at all, and a
    missing import there would answer that question with a crash.
    """
    try:
        from langchain_anthropic import ChatAnthropic
    except ImportError:
        return False
    return isinstance(model, ChatAnthropic)


async def answer(state: MessagesState):
    from openai import AuthenticationError, PermissionDeniedError
    from langchain_openai.chatgpt_oauth import _ChatGPTOAuthRefreshError

    try:
        model = await _plan_model()
        messages = model_messages(state["messages"])
        if _wants_system_turns_first(model):
            messages = _system_turns_first(messages)
        return {"messages": [await bind_tools(model).ainvoke(messages)]}
    except (AuthenticationError, PermissionDeniedError, _ChatGPTOAuthRefreshError) as error:
        # Typed provider boundary only. A callback or harness 401 is a different credential. A
        # 403 for an account out of credit (xAI answers so) is not a sign-in problem at all.
        if not billing_refusal(error):
            current_tools().connection["authentication_failed"] = True
        raise
    except Exception as error:
        if provider_refusal(error) and chatgpt_models.is_model_refusal(provider_message(error)):
            # The plan no longer offers a model it listed: read the listing again before the
            # next answer instead of trusting this one for the rest of its six hours.
            chatgpt_models.PLAN_MODELS.invalidate()
        raise


builder = StateGraph(MessagesState)
builder.add_node("answer", answer)
builder.add_edge(START, "answer")
builder.add_node("tools", execute_tools)
builder.add_conditional_edges("answer", next_step)
builder.add_edge("tools", "answer")
# A checkpointer, because the AG-UI integration reads a thread's state by id and LangGraph refuses
# to without one. In memory rather than in Postgres: OpenBot's database is where a conversation
# lives, and two stores remembering the same thread is how they come to disagree. So this one is
# never used across runs either: `WholeThreadAgent` gives every run its own, empty.
graph = builder.compile(checkpointer=MemorySaver())

app = FastAPI()


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
    return {"ok": True, "harness": "langgraph"}


@app.get("/models")
async def plan_models():
    """The models the signed-in ChatGPT plan offers, for the server's model picker.

    `{"object": "list", "data": [{"id", "label", "efforts", "default_effort", "priority"}]}`, in
    the plan's own order, the first being its default; a key the listing had no value for is left
    out. Only a Bot signed in to a plan has one: any other Bot's models are its provider's to list.
    """
    store = (os.environ.get("CHATGPT_AUTH_FILE") or "").strip()
    if not store:
        return JSONResponse(
            {"error": "This Bot is not signed in to a ChatGPT plan."}, status_code=404
        )
    from .chatgpt_store import ChatGptTokenStore

    try:
        token_provider = ChatGptTokenStore(path=_chatgpt_auth_file(store))
    except OSError:
        return JSONResponse(
            {"error": "This Bot's ChatGPT sign-in could not be read."}, status_code=502
        )
    models = await chatgpt_models.PLAN_MODELS.models(token_provider)
    if models is None:
        return JSONResponse(
            {"error": "The ChatGPT plan's model list could not be read."}, status_code=502
        )
    return {"object": "list", "data": [model.as_entry() for model in models]}


add_langgraph_fastapi_endpoint(
    app=app,
    agent=ToolAwareAgent(name="openbot", graph=graph, config={"recursion_limit": 25}),
    path="/",
)
