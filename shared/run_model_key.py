"""A run's own key to OpenBot's model gateway, for every Python harness OpenBot runs.

One harness serves every organization of an OpenBot. Its model calls go to the server's model
gateway (`/api/model-provider/...`), which answers each on the AI connection of the organization
the caller's key names. The key in the harness's environment is the deployment's gateway token,
and it names one organization. So the server sends each run a token of its own, minted for that
run in its organization, as `forwardedProps.openbotModelRoute: {"via": ..., "token": ...}`, and the
harness calls the model with it for that run.

THE FRAMEWORKS BUILD THEIR MODEL CLIENTS ONCE, at start, from the environment, and each has its own
way of doing it. So the key is swapped where every one of them ends up: the HTTP request. A harness
wraps its app in `RunModelKey`, which reads the token from the run's body (and takes the server's
props out of it, so no framework ever holds the token in its state), and keeps it for the run in
a context variable; every request the harness then sends through `httpx` (the OpenAI and Anthropic
SDKs, LiteLLM and the rest) carries it in place of the environment's key.

ONLY TO THE GATEWAY. The token replaces a key only on a request whose path is the gateway's
(`/api/model-provider/`). A harness given a provider key of its own sends that key to the provider
as before, and a run that brought no token sends what it always sent.
"""

from __future__ import annotations

import json
from contextvars import ContextVar
from typing import Any

GATEWAY_PATH = "/api/model-provider/"

# The props only the server writes and only this module reads, taken out of every run.
SERVER_PROPS = (
    "openbotModelRoute",
    "openbotOrganization",
    "openbot_model_route",
    "openbot_organization",
)

_run_key: ContextVar[str | None] = ContextVar("openbot_run_model_key", default=None)


def run_key() -> str | None:
    """The token of the run in progress, or None."""
    return _run_key.get()


def key_from(props: Any) -> str:
    """The token the server sent in a run's forwarded props, or an empty string."""
    if not isinstance(props, dict):
        return ""
    route = props.get("openbotModelRoute")
    if not isinstance(route, dict) or route.get("via") not in ("openai", "anthropic"):
        return ""
    token = route.get("token")
    return token.strip() if isinstance(token, str) else ""


def with_run_key(headers: Any, path: str) -> None:
    """The run's token in place of the key on a request to the gateway; nothing otherwise.

    OpenAI's SDK sends its key as `Authorization: Bearer`, Anthropic's as `x-api-key`. Each is
    replaced where it is; a request with neither is given the bearer the gateway reads first.
    """
    key = _run_key.get()
    if not key or GATEWAY_PATH not in path:
        return
    had_api_key = "x-api-key" in headers
    if had_api_key:
        headers["x-api-key"] = key
    if "authorization" in headers or not had_api_key:
        headers["authorization"] = f"Bearer {key}"


_installed = False


def install() -> None:
    """Every HTTP request of this process carries the run's token to the gateway. Idempotent.

    `httpx` and `httpx2`, the fork the OpenAI and Anthropic SDKs moved to; a framework that uses
    either sends through `Client.send` or `AsyncClient.send`, whatever it builds on top.
    """
    global _installed
    if _installed:
        return
    import importlib

    for name in ("httpx", "httpx2"):
        try:
            module = importlib.import_module(name)
        except ImportError:
            continue
        _patch(module.Client, module.AsyncClient)
    _installed = True


def _patch(client, async_client) -> None:
    sync_send = client.send
    async_send = async_client.send

    def send(self, request, *args, **kwargs):
        with_run_key(request.headers, request.url.path)
        return sync_send(self, request, *args, **kwargs)

    async def asend(self, request, *args, **kwargs):
        with_run_key(request.headers, request.url.path)
        return await async_send(self, request, *args, **kwargs)

    client.send = send
    async_client.send = asend


class RunModelKey:
    """ASGI middleware: the run's token kept for the run, and the server's props taken out.

    Reads a POST's JSON body whole, takes `SERVER_PROPS` out of its `forwardedProps`, and hands the
    app the body without them. The token is kept in a context variable for as long as the app
    answers, which every task the app starts inherits.
    """

    def __init__(self, app):
        self.app = app
        install()

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        chunks = []
        while True:
            message = await receive()
            if message["type"] != "http.request":
                # The client went away before the body was whole: nothing to run.
                await self.app(scope, _replay(b"", receive), send)
                return
            chunks.append(message.get("body", b""))
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        token = ""
        try:
            parsed = json.loads(body) if body else None
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            props = parsed.get("forwardedProps")
            if not isinstance(props, dict):
                props = parsed.get("forwarded_props")
            if isinstance(props, dict):
                token = key_from(props)
                if any(name in props for name in SERVER_PROPS):
                    for name in SERVER_PROPS:
                        props.pop(name, None)
                    body = json.dumps(parsed).encode("utf-8")
                    scope = {
                        **scope,
                        "headers": [
                            (name, value)
                            for name, value in scope.get("headers", [])
                            if name.lower() != b"content-length"
                        ]
                        + [(b"content-length", str(len(body)).encode("ascii"))],
                    }
        reset = _run_key.set(token or None)
        try:
            await self.app(scope, _replay(body, receive), send)
        finally:
            _run_key.reset(reset)


def _replay(body: bytes, receive):
    """`receive`, answering the body once and then whatever the client sends next."""
    sent = False

    async def replay():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await receive()

    return replay
