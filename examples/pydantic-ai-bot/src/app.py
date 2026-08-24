"""
A Bot written in Pydantic AI.

Like the LangGraph and Mastra examples, this shares no OpenBot-specific code beyond the AG-UI
protocol. The browser and file tools arrive in each run's ``tools`` from the surface, and Pydantic AI
exposes them to the model as external tools whose calls stream back to OpenBot rather than executing
here. So this process drives a governed browser it has no direct access to.

Unlike those two, it is Python. OpenBot knows a Bot only as an AG-UI endpoint URL, so the language
and framework behind that URL are the deployment's business, not the surface's. This is the same
contract as ``agent-bot``, the LangGraph example, and the Mastra example, in a third language.
"""

import os

from pydantic_ai import Agent
from pydantic_ai.ui.ag_ui import AGUIAdapter
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

MODEL = os.environ.get("BOT_MODEL", "gpt-5.5")

# A real Pydantic AI agent with its own model client. It defines no tools of its own: the tools it
# may call arrive per run from the surface (see below), so this file never names `computer_navigate`
# and still drives a governed browser.
agent = Agent(
    f"openai:{MODEL}",
    instructions=(
        "You are a Bot running on Pydantic AI inside OpenBot. You have a real web browser available "
        "through the tools you are given.\n\n"
        # Same guard as the LangGraph and Mastra examples: page contents require a fresh tool result.
        "NEVER state what a page contains unless you have just read it with a tool in this "
        "conversation. You cannot know a page's contents from memory, and a plausible guess is a "
        "wrong answer. If you have not read it, call the tool first, and report exactly what the "
        "tool returned."
    ),
)


async def ag_ui(request: Request) -> Response:
    """One POST carrying a ``RunAgentInput``, a stream of AG-UI events back.

    Guarded by ``REQUIRE_KEY`` when it is set, the same as the LangGraph example: OpenBot sends the
    Bot's key on every run, and an endpoint that never reads the header accepts a run from anyone who
    can reach the port. Optional because a developer running this by hand has no key to send, and
    refusing them would teach nothing.

    ``AGUIAdapter.dispatch_request`` reads the run input, exposes ``input.tools`` to the model as
    external (frontend) tools, runs the agent, and returns a streaming AG-UI Server-Sent-Events
    response. The tool loop stays on the client, exactly as it does for the Bot in the box: a tool
    call is emitted, this run ends, and OpenBot executes it through the policy gateway before starting
    the next run with the result. That is why this file can drive a browser it has no access to.
    """
    required_key = os.environ.get("REQUIRE_KEY")
    if required_key and request.headers.get("authorization") != required_key:
        print("refused a run: wrong or missing key")
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    return await AGUIAdapter.dispatch_request(request, agent=agent)


async def health(_: Request) -> Response:
    return JSONResponse({"status": "ok", "framework": "pydantic-ai"})


app = Starlette(
    routes=[
        Route("/health", health),
        Route("/ag-ui", ag_ui, methods=["POST"]),
    ],
)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "4600"))
    print(f"pydantic-ai-bot listening on http://localhost:{port}/ag-ui (model {MODEL})")
    uvicorn.run(app, host="0.0.0.0", port=port)
