"""Claude Agent SDK as a Bot, through `ag-ui-claude-sdk`.

This is the row where a plan can stand in for a key. `claude setup-token` mints a
`CLAUDE_CODE_OAUTH_TOKEN` against a Pro or Max subscription and the SDK accepts it, which is why
this harness is the one the model screen offers a subscription on.

The precedence trap is the thing to get right: `ANTHROPIC_API_KEY` wins over the OAuth token, so a
deployment that sets both silently bills the key and the plan goes unused. OpenBot sets one.
"""

import os

from ag_ui_claude_sdk import ClaudeAgentAdapter, add_claude_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

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
    return {"ok": True, "harness": "claude-agent-sdk"}


add_claude_fastapi_endpoint(
    app=app,
    adapter=ClaudeAgentAdapter(name="openbot"),
    path="/",
)
