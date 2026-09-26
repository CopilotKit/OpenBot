"""Google ADK as a Bot, through `ag_ui_adk`, which AG-UI maintains.

ADK is Gemini-first and model-agnostic after that, so the provider stays the person's choice: ADK
reads LiteLLM model strings, and OpenBot writes the one it was told.
"""

import os

from ag_ui_adk import ADKAgent, AGUIToolset, add_adk_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm

TOKEN_HEADER = "x-openbot-agent-token"


class CompleteToolCallsLiteLlm(LiteLlm):
    """Keep tool args together at AG-UI's long-running tool boundary.

    ADK 2.10 streams partial FunctionCalls before their args exist. AG-UI 0.7
    treats the first long-running FunctionCall as complete and deduplicates the
    final one, losing its arguments. Wait for the complete call, while allowing
    ordinary text deltas to stream normally. No tool is executed here.
    """

    async def generate_content_async(self, llm_request, stream=False):
        async for response in super().generate_content_async(llm_request, stream):
            if response.partial and response.content and any(
                part.function_call for part in response.content.parts or []
            ):
                remaining = [
                    part for part in response.content.parts or []
                    if not part.function_call
                ]
                if not remaining:
                    continue
                response = response.model_copy(update={
                    "content": response.content.model_copy(update={"parts": remaining})
                })
            yield response



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
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    model = (os.environ.get("BOT_MODEL") or "gpt-4o-mini").strip()
    return f"{provider}/{model}"


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
    return {"ok": True, "harness": "google-adk"}


add_adk_fastapi_endpoint(
    app,
    ADKAgent(
        adk_agent=Agent(
            name="openbot",
            tools=[AGUIToolset()],
            model=CompleteToolCallsLiteLlm(model=_model_id()),
            instruction="Answer the question you are asked, briefly and correctly.",
        ),
        app_name="openbot",
        user_id="openbot",
    ),
    path="/",
)
