"""The token check on a route the middleware actually guards.

`/health` is exempt on purpose, so a test that sends tokens there cannot tell a correct
comparison from a broken one — every case answers 200 regardless of the token. `/model/cancel`
is protected, and calling it with a `threadId` nothing has ever seen is a safe way to reach a real
route handler without a Claude subprocess: `OpenBotClaudeAgentAdapter.interrupt()` no-ops when the
thread isn't tracked.

The non-ASCII case is the one that distinguishes `hmac.compare_digest` on `str` (raises,
answering 500) from `hmac.compare_digest` on UTF-8 bytes (returns `False`, answering 401) — a
header byte outside ASCII decodes to a non-ASCII Python `str` the same way a byte from the wire
would, once Starlette applies its latin-1 header decoding.
"""

import asyncio
import importlib
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "valid-test-token"


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-test-key")
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    from src import main

    return importlib.reload(main).app


def _post(app, path, headers):
    async def send():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://harness") as client:
            return await client.post(path, headers=headers, json={"threadId": "never-seen-thread"})

    return asyncio.run(send())


def test_the_correct_token_reaches_the_route(app):
    response = _post(app, "/model/cancel", {"x-openbot-agent-token": TOKEN})
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_a_wrong_token_is_rejected(app):
    response = _post(app, "/model/cancel", {"x-openbot-agent-token": "wrong-token"})
    assert response.status_code == 401


def test_a_missing_token_is_rejected(app):
    response = _post(app, "/model/cancel", {})
    assert response.status_code == 401


def test_a_non_ascii_token_is_rejected_not_a_server_error(app):
    """`hmac.compare_digest` raises on a non-ASCII `str`; comparing bytes never does."""
    response = _post(app, "/model/cancel", {"x-openbot-agent-token": b"\xe9\xe9\xe9\xe9"})
    assert response.status_code == 401


@pytest.mark.parametrize("headers", [{}, {"x-openbot-agent-token": "wrong-token"}])
def test_health_stays_exempt_regardless_of_token(app, headers):
    async def send():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://harness") as client:
            return await client.get("/health", headers=headers)

    response = asyncio.run(send())
    assert response.status_code == 200
