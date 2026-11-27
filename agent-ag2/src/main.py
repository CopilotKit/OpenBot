"""AG2 as a Bot. AG-UI is an extra in AG2's own package, so `ag2[ag-ui]` is the dependency."""

import hmac
import os
import re
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import SPEC, bot_settings, openai_api
from run_model_key import RunModelKey
import gemini_signatures

# Every Gemini tool call this Bot sends back is signed. See gemini_signatures.py.
gemini_signatures.install()

from ag2 import Agent
from ag2.ag_ui import AGUIStream
from ag2.config import (
    AnthropicConfig,
    GeminiConfig,
    OpenAICompletionsConfig,
    OpenAIResponsesConfig,
)
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

TOKEN_HEADER = "x-openbot-agent-token"


def _config() -> (
    AnthropicConfig | GeminiConfig | OpenAICompletionsConfig | OpenAIResponsesConfig
):
    """The provider the model screen chose, which AG2 reaches through a config of its own.

    `BOT_PROVIDER` is `anthropic` for an Anthropic key, `google` for a Gemini key, and `openai`
    otherwise, an OpenAI-compatible endpoint included. Each SDK reads its own key from the
    environment.

    A Gemini key takes AG2's Gemini config, on Google's own API. Before, `google` fell through to
    the OpenAI config, which asked for `OPENAI_API_KEY` and sent the Gemini model to OpenAI. The
    Gemini config also hands a call's thought signature to AG-UI and takes it back on a
    handed-back call, where the server keeps it.

    An OpenAI model takes AG2's Responses config when it takes function tools only there
    (`gpt-5.6` and later, `gpt-5.4` and `gpt-5.5` once a run carries an effort, the `-pro` models:
    "To use function tools, use /v1/responses"), and the
    Chat Completions config otherwise, which every OpenAI-compatible endpoint serves. Both are
    named explicitly: AG2 1.4.0 turns the bare `OpenAIConfig` into the Responses config, which
    would move every compatible endpoint onto an API most of them do not serve.
    """
    settings = bot_settings("agent-ag2")
    provider = settings.provider
    model = settings.model
    if provider == "google":
        google = SPEC["providers"]["google"]
        base_url = (os.environ.get(google["base_url_variable"]) or "").strip()
        if base_url:
            # google-genai's own name for the address, which it reads when it builds its client.
            # It adds the API version itself, so one the address ends in (`.../v1beta`, as the AI
            # SDK takes it) is left off.
            version = r"/v\d+(?:alpha|beta)?\d*/?$"
            os.environ["GOOGLE_GEMINI_BASE_URL"] = re.sub(version, "", base_url)
        api_key = (os.environ.get(google["key_variable"]) or "").strip() or None
        return GeminiConfig(model=model, api_key=api_key)
    if provider == "anthropic":
        # Compose exports missing overrides as ""; the SDK only defaults an absent URL.
        base_url = (os.environ.get("ANTHROPIC_BASE_URL") or "").strip() or "https://api.anthropic.com"
        return AnthropicConfig(model=model, base_url=base_url)
    # The same "" for OPENAI_BASE_URL, which Compose writes whenever the model screen chose a plain
    # OpenAI key. The SDK only defaults an absent URL; given "", every request fails to connect.
    base_url = (os.environ.get("OPENAI_BASE_URL") or "").strip() or "https://api.openai.com/v1"
    if openai_api(model) == "responses":
        return OpenAIResponsesConfig(model=model, base_url=base_url)
    return OpenAICompletionsConfig(model=model, base_url=base_url)


agent = Agent(
    name="openbot",
    prompt="Answer the question you are asked, briefly and correctly.",
    config=_config(),
)
stream = AGUIStream(agent)

app = FastAPI()
# Each run's model calls carry its own gateway token, in its organization. See run_model_key.py.
app.add_middleware(RunModelKey)


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
    return {"ok": True, "harness": "ag2"}


# `build_asgi` rather than a helper: AG2 hands back a plain ASGI app to mount.
app.mount("/", stream.build_asgi())
