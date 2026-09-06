"""Microsoft Agent Framework as a Bot, through `agent-framework-ag-ui`, which Microsoft publishes."""

import os

from agent_framework.openai import OpenAIChatClient
from agent_framework_ag_ui import add_agent_framework_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

TOKEN_HEADER = "x-openbot-agent-token"

agent = OpenAIChatClient(
    (os.environ.get("BOT_MODEL") or "gpt-4o-mini").strip()
).as_agent(instructions="Answer the question you are asked, briefly and correctly.")

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
    return {"ok": True, "harness": "microsoft-agent-framework"}


add_agent_framework_fastapi_endpoint(app, agent, "/")
