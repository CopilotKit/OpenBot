"""Agno as a Bot.

The AG-UI support is an extra in Agno's own package rather than a separate bridge, so `agno[agui]`
is the whole dependency and `AGUIApp` is the whole integration. Nothing of the protocol is written
here, which is the rule.
"""

import os

from agno.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.models.litellm import LiteLLM
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI
from fastapi import Request
from fastapi.responses import JSONResponse

TOKEN_HEADER = "x-openbot-agent-token"


def _model_id() -> str:
    """`provider/model`, which is how litellm addresses one and how OpenBot stores the choice."""
    provider = (os.environ.get("BOT_PROVIDER") or "openai").strip()
    model = (os.environ.get("BOT_MODEL") or "gpt-5.5").strip()
    return model if "/" in model else f"{provider}/{model}"


agent = Agent(
    # In memory, because a Bot's history lives in OpenBot's database and not in the harness. Two
    # places remembering the same conversation is how they come to disagree.
    db=InMemoryDb(),
    model=LiteLLM(id=_model_id()),
    # No role, goal or backstory invented on somebody's behalf. A Bot answers the question it is
    # asked, and anybody who wants a persona sets one in OpenBot where the rest of them live.
    instructions="Answer the question you are asked, briefly and correctly.",
)

app = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)]).get_app()


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    """Everything but `/health` carries the server's token.

    `/health` is exempt because Compose polls it before any token exists, and a healthcheck that
    authenticates is a container that never reports healthy.
    """
    if request.url.path != "/health":
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        # Unset means unconfigured, not open.
        if not expected or offered != expected:
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "agno"}
