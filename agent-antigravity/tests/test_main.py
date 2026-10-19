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
    assert src.main._model() == "gemini-3.6-flash"


def _rebuilt():
    import src.main

    importlib.reload(src.main)
    return src.main


def test_a_base_url_becomes_a_gemini_endpoint(monkeypatch):
    """The variable the `google` provider row names points the harness somewhere else.

    Reading `_endpoint` is reaching into the SDK, and that is deliberate: the alternative is a test
    that only greps this Bot's source, which would pass just as happily with the wrong keyword.
    `AntigravityAgent(base_url=...)` is the wrong keyword — it is a separate path for
    unauthenticated local servers and it carries no key — so this asserts the key came along.
    """
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("GOOGLE_API_KEY", "not-a-real-key")
    monkeypatch.setenv("GOOGLE_GENERATIVE_AI_BASE_URL", "http://aimock:4141")
    monkeypatch.delenv("BOT_PROVIDER", raising=False)
    monkeypatch.delenv("BOT_MODEL", raising=False)
    agent = _rebuilt()._agent()
    assert agent._endpoint.base_url == "http://aimock:4141"
    assert agent._endpoint.api_key == "not-a-real-key"


def test_without_a_base_url_the_key_goes_straight_to_google(monkeypatch):
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("GOOGLE_API_KEY", "not-a-real-key")
    monkeypatch.delenv("GOOGLE_GENERATIVE_AI_BASE_URL", raising=False)
    monkeypatch.delenv("BOT_PROVIDER", raising=False)
    monkeypatch.delenv("BOT_MODEL", raising=False)
    agent = _rebuilt()._agent()
    assert agent._endpoint is None
    assert agent._api_key == "not-a-real-key"


def test_a_blank_base_url_is_not_a_choice(monkeypatch):
    """Compose hands an unset variable through as an empty string, and `GeminiAPIEndpoint("")`
    would send the harness at nothing at all."""
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("GOOGLE_API_KEY", "not-a-real-key")
    monkeypatch.setenv("GOOGLE_GENERATIVE_AI_BASE_URL", "   ")
    monkeypatch.delenv("BOT_PROVIDER", raising=False)
    monkeypatch.delenv("BOT_MODEL", raising=False)
    assert _rebuilt()._agent()._endpoint is None


def test_the_sdks_own_spelling_of_the_key_is_taken_too(monkeypatch):
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "from-the-other-name")
    monkeypatch.delenv("GOOGLE_GENERATIVE_AI_BASE_URL", raising=False)
    monkeypatch.delenv("BOT_PROVIDER", raising=False)
    monkeypatch.delenv("BOT_MODEL", raising=False)
    assert _rebuilt()._agent()._api_key == "from-the-other-name"
