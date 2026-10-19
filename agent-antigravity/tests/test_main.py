"""The app this Bot actually serves: it builds, it guards, and health stays open.

Importing `src.main` is most of the point. It constructs a real `AntigravityAgent` and a real
FastAPI app at module scope, so a wrong keyword, a renamed export or a missing dependency fails
here rather than at the first run against a live deployment.
"""

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "test-managed-token"
TOKEN_HEADER = "x-openbot-agent-token"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("GOOGLE_API_KEY", "not-a-real-key")
    monkeypatch.delenv("BOT_PROVIDER", raising=False)
    monkeypatch.delenv("BOT_MODEL", raising=False)
    import src.main

    importlib.reload(src.main)
    return TestClient(src.main.app)


def test_health_needs_no_token(client):
    """Compose polls this before anything holds a token."""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "harness": "antigravity"}


def test_a_run_without_the_server_token_is_refused(client):
    response = client.post("/", json={})
    assert response.status_code == 401


def test_a_run_with_the_wrong_token_is_refused(client):
    response = client.post("/", json={}, headers={TOKEN_HEADER: "wrong"})
    assert response.status_code == 401


def test_the_token_gate_is_not_a_prefix_match(client):
    """`hmac.compare_digest` on the whole value, not a startswith."""
    response = client.post("/", json={}, headers={TOKEN_HEADER: TOKEN + "extra"})
    assert response.status_code == 401


def test_the_agent_is_built_on_the_pinned_provider(monkeypatch):
    """Even told to use OpenAI, this Bot asks Antigravity for a Gemini."""
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("GOOGLE_API_KEY", "not-a-real-key")
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.delenv("BOT_MODEL", raising=False)
    import src.main

    importlib.reload(src.main)
    assert src.main._model() == "gemini-2.5-flash"
