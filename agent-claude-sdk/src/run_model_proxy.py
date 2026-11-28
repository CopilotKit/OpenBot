"""Claude Code's model calls on a run's own gateway token, in its organization.

One harness serves every organization of an OpenBot. Its model calls go to the server's model
gateway, which answers each on the AI connection of the organization the caller's key names, and
the key in this container's environment names one organization. So the server sends each run a
token of its own (`openbotModelRoute`), which `RunModelKey` keeps for the run
(`shared/run_model_key.py`).

The Python harnesses send their model calls themselves, and that module puts the token on each.
Here Claude Code sends them, from a process of its own that lives across runs: a query waits on a
tool's result while the person decides, and the next run carries it on. A key fixed in its
environment would be the first run's, past its ten minutes. So a query on the gateway is pointed at
this harness instead, on a path only it knows (`/_run-model/<secret>`), and every call it makes is
passed on to the gateway with the newest token any run of that thread brought.

Only where the configured address is the gateway's (`/api/model-provider/`) and a run brought a
token. Otherwise Claude Code is given what it always was.
"""

import os
import secrets
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

# The module every Python harness shares: beside this harness in the repository, at /shared in the
# image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from run_model_key import GATEWAY_PATH, run_key  # noqa: E402

PROXY_PATH = "/_run-model/"

# A thread's slot outlives a run: its query may wait on a person for hours. One a day old is gone.
SLOT_SECONDS = 24 * 60 * 60


class _Slot:
    __slots__ = ("secret", "key", "at")

    def __init__(self, secret: str, key: str):
        self.secret = secret
        self.key = key
        self.at = time.monotonic()


_by_thread: dict[str, _Slot] = {}
_by_secret: dict[str, _Slot] = {}


def _gateway_base() -> str:
    base = (os.environ.get("ANTHROPIC_BASE_URL") or "").strip().rstrip("/")
    return base if base and GATEWAY_PATH in urlsplit(base).path + "/" else ""


def _forget_old(now: float) -> None:
    for thread, slot in list(_by_thread.items()):
        if now - slot.at > SLOT_SECONDS:
            del _by_thread[thread]
            _by_secret.pop(slot.secret, None)


def query_environment(thread_id: str | None) -> dict[str, str]:
    """What a new query of `thread_id` is started with, so its calls come back through here.

    Empty where the run brought no token or the configured address is not the gateway's.
    """
    key = run_key()
    if not key or not thread_id or not _gateway_base():
        return {}
    now = time.monotonic()
    _forget_old(now)
    slot = _by_thread.get(thread_id)
    if slot is None:
        slot = _Slot(secrets.token_urlsafe(32), key)
        _by_thread[thread_id] = slot
        _by_secret[slot.secret] = slot
    slot.key, slot.at = key, now
    port = (os.environ.get("PORT") or "4212").strip()
    return {
        "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}{PROXY_PATH}{slot.secret}",
        # Claude Code needs a key to start; the one it sends is replaced on the way out.
        "ANTHROPIC_API_KEY": "openbot-run-model",
    }


def refresh(thread_id: str | None) -> None:
    """A run of `thread_id` brought a newer token: the query it carries on sends that from now."""
    key = run_key()
    slot = _by_thread.get(thread_id or "")
    if key and slot is not None:
        slot.key, slot.at = key, time.monotonic()


def slot_key(secret: str) -> str | None:
    slot = _by_secret.get(secret)
    return slot.key if slot is not None else None


# What is not passed on to the gateway: how this hop was made, and the key Claude Code was given.
_REQUEST_DROPPED = {"host", "content-length", "connection", "authorization", "x-api-key"}
# What is not passed back: how the gateway's answer was framed, which this hop frames again.
_RESPONSE_DROPPED = {"content-length", "transfer-encoding", "connection"}

_client = None


async def forward(request, secret: str, path: str):
    """One of Claude Code's model calls, passed on to the gateway with its thread's newest token."""
    import httpx
    from fastapi.responses import JSONResponse, StreamingResponse
    from starlette.background import BackgroundTask

    global _client
    key = slot_key(secret)
    base = _gateway_base()
    client_host = request.client.host if request.client else ""
    if not key or not base or client_host not in ("127.0.0.1", "::1"):
        return JSONResponse({"error": "not found"}, status_code=404)
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=30.0))
    target = f"{base}/{path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"
    headers = {
        name: value
        for name, value in request.headers.items()
        if name.lower() not in _REQUEST_DROPPED
    }
    headers["x-api-key"] = key
    upstream = _client.build_request(
        request.method, target, headers=headers, content=await request.body()
    )
    response = await _client.send(upstream, stream=True)
    return StreamingResponse(
        response.aiter_raw(),
        status_code=response.status_code,
        headers={
            name: value
            for name, value in response.headers.items()
            if name.lower() not in _RESPONSE_DROPPED
        },
        background=BackgroundTask(response.aclose),
    )
