"""Claude Agent SDK as a Bot, through `ag-ui-claude-sdk`.

This is the row where a plan can stand in for a key. `claude setup-token` mints a
`CLAUDE_CODE_OAUTH_TOKEN` against a Pro or Max subscription and the SDK accepts it, which is why
this harness is the one the model screen offers a subscription on.

The precedence trap is the thing to get right: `ANTHROPIC_API_KEY` wins over the OAuth token, so a
deployment that sets both silently bills the key and the plan goes unused. OpenBot sets one.
"""

import hmac
import os

from ag_ui_claude_sdk import add_claude_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .adapter import OpenBotClaudeAgentAdapter
from .replay import finish_regardless
from .run_model_proxy import PROXY_PATH, forward
from run_model_key import RunModelKey  # On the path run_model_proxy puts shared/ on.

TOKEN_HEADER = "x-openbot-agent-token"


def _refuse_both_credentials() -> None:
    """One credential or the other, never both.

    Anthropic resolves `ANTHROPIC_API_KEY` ahead of `CLAUDE_CODE_OAUTH_TOKEN`, so a container given
    both uses the key and quietly ignores the subscription somebody chose. Failing here is the only
    way that becomes visible: the alternative is a correct-looking Bot on the wrong credential.
    """
    key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    plan = (os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or "").strip()
    if key and plan:
        raise SystemExit(
            "Both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set. Anthropic prefers the key, "
            "so the subscription would be ignored. Set one."
        )
    if not key and not plan:
        raise SystemExit(
            "Set ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`."
        )


_refuse_both_credentials()

app = FastAPI()
# Each run's model calls carry its own gateway token, in its organization. See run_model_proxy.py.
app.add_middleware(RunModelKey)


@app.middleware("http")
async def refuse_without_the_server_token(request: Request, call_next):
    # Claude Code's own model calls come back here on a secret path of their query's, from this
    # container's loopback, and carry no server token. See run_model_proxy.py.
    if request.url.path != "/health" and not request.url.path.startswith(PROXY_PATH):
        expected = (os.environ.get("MANAGED_AGENT_TOKEN") or "").strip()
        offered = (request.headers.get(TOKEN_HEADER) or "").strip()
        if not expected or not hmac.compare_digest(offered.encode("utf-8"), expected.encode("utf-8")):
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "harness": "claude-agent-sdk"}


@app.api_route(PROXY_PATH + "{secret}/{path:path}", methods=["GET", "POST"])
async def run_model(request: Request, secret: str, path: str):
    return await forward(request, secret, path)


add_claude_fastapi_endpoint(
    app=app,
    adapter=OpenBotClaudeAgentAdapter(name="openbot"),
    path="/",
)

model_adapter = OpenBotClaudeAgentAdapter(name="openbot-model", model_only=True)
add_claude_fastapi_endpoint(
    app=app,
    adapter=model_adapter,
    path="/model",
)


class CancelModelRun(BaseModel):
    threadId: str = Field(min_length=1, max_length=128)


@app.post("/model/cancel")
async def cancel_model_run(request: CancelModelRun):
    # Finished even if the caller stops waiting: the plan model gives up on this request after 5s.
    await finish_regardless(model_adapter.interrupt(request.threadId))
    return {"ok": True}
