"""Google ADK as a Bot, through `ag_ui_adk`, which AG-UI maintains.

ADK is Gemini-first and model-agnostic after that, so the provider stays the person's choice: ADK
reads LiteLLM model strings, and OpenBot writes the one it was told.
"""

from contextlib import aclosing
import hmac
import os
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import bot_settings

from ag_ui.core import DeveloperMessage, RunAgentInput, SystemMessage
from ag_ui_adk import ADKAgent, AGUIToolset, add_adk_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm
from google.adk.sessions import InMemorySessionService

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



def _role_first(input: RunAgentInput) -> RunAgentInput:
    """Every system and developer message of this run, as the one system message ADK reads.

    `ag_ui_adk` appends `messages[0]` to the agent's instruction when it is a system message and
    drops every other one: history seeding has no place for them and only the newest user message
    is dispatched. The server sends two, the standing role and then the granted-tools summary, so
    the summary never reached the model. Folding them into one, in order, puts all of them in the
    instruction, rebuilt from this run's input on every run, so a grant that changed since the
    last run (same id, new content) is the one the model is told about.
    """
    system = [m for m in input.messages if isinstance(m, (SystemMessage, DeveloperMessage))]
    if not system:
        return input
    role = SystemMessage(
        id=system[0].id,
        role="system",
        content="\n\n".join(m.content for m in system if m.content),
    )
    rest = [m for m in input.messages if not isinstance(m, (SystemMessage, DeveloperMessage))]
    return input.model_copy(update={"messages": [role, *rest]})


class WholeThreadADKAgent(ADKAgent):
    async def _drop_a_session_that_missed_a_turn(self, input: RunAgentInput) -> None:
        """Start again from the thread when this process's session never saw one of its turns.

        `ag_ui_adk` sends the model the session's own history plus the messages its ledger has not
        seen, so a live session wins over the thread the server sent. A turn another replica
        answered was never in this session, and the Bot answered as if it had not happened. Every
        earlier user message of the thread must be in the ledger; when one is not, the session is
        deleted (its ledger with it, since the session id is the thread id) and the library seeds a
        new one from the whole thread, as after a restart. A session waiting on a client tool
        result is kept: the result belongs to that session's pending call.
        """
        app_name, user_id = self._get_app_name(input), self._get_user_id(input)
        manager = self._session_manager
        seen = manager.get_processed_message_ids(app_name, input.thread_id, user_id=user_id)
        if not seen:
            return
        users = [m.id for m in input.messages if getattr(m, "role", None) == "user" and m.id]
        if set(users[:-1]) <= seen:
            return
        session = await manager.get_session(input.thread_id, app_name, user_id)
        if session is None or (session.state or {}).get("pending_tool_calls"):
            return
        await manager._delete_session(session)

    async def run(self, input: RunAgentInput):
        await self._drop_a_session_that_missed_a_turn(input)
        async with aclosing(super().run(_role_first(input))) as events:
            async for event in events:
                yield event


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
    settings = bot_settings("agent-adk")
    provider = settings.provider
    model = settings.model
    return f"{provider}/{model}"


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
    return {"ok": True, "harness": "google-adk"}


agent = WholeThreadADKAgent(
    adk_agent=Agent(
        name="openbot",
        tools=[AGUIToolset()],
        model=CompleteToolCallsLiteLlm(model=_model_id()),
        instruction="Answer the question you are asked, briefly and correctly.",
    ),
    app_name="openbot",
    user_id="openbot",
    # The session is a cache of the thread the server sends every run, never its record. The
    # library forgets a session idle for 20 minutes, but its ledger of messages already seen is
    # keyed by thread and cleared on that delete only when the session id is the thread id. With
    # generated ids the ledger outlived the session, so the next turn found every earlier message
    # "seen", started an empty session and showed the model only the newest question. With the
    # thread id as the session id, an expired session takes its ledger with it, and the next turn
    # seeds a new session from the whole thread, as after a restart.
    # A service of its own gives this agent its own manager, so these settings hold (the shared
    # default keeps whatever the first agent in the process asked for).
    session_service=InMemorySessionService(),
    use_thread_id_as_session_id=True,
    # An expired session copied into the in-memory memory service is never read and never freed.
    save_session_to_memory_on_cleanup=False,
)

add_adk_fastapi_endpoint(app, agent, path="/")
