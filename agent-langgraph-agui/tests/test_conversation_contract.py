"""A LangGraph Bot answers from the whole thread the server sent, in the Bot's role, on every run.

See `shared/harness_contract.py` for what the contract is and why it is checked at the model. Two
cases: a fresh process, and a warm one that has already answered on the same thread, because the
AG-UI integration merges the request into a checkpoint it keeps between runs.
"""

import importlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import (
    BOT,
    EARLIER_ANSWER,
    EARLIER_QUESTION,
    GRANTED_TOOLS,
    LATEST_QUESTION,
    STANDING_ROLE,
    anthropic_environment,
    conversation,
    fake_provider,
    missing_from,
    openai_environment,
    run_events,
)

TOKEN = "contract-token"
NEW_GRANTED_TOOLS = "CONTRACT_GRANTED_TOOLS_CHANGED_9c1e"
NEWER_QUESTION = "CONTRACT_NEWER_QUESTION_9c1e"


def _fresh_app(monkeypatch, environment, base):
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.delenv("CHATGPT_AUTH_FILE", raising=False)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    for key, value in environment(base).items():
        monkeypatch.setenv(key, value)

    # A fresh process has no pooled provider connections either. `langchain-openai` keeps one
    # HTTP client per base URL for the life of the process, and a connection it pooled in an
    # earlier test's event loop cannot be closed from this one.
    from langchain_openai.chat_models import _client_utils

    _client_utils._cached_async_httpx_client.cache_clear()
    _client_utils._cached_sync_httpx_client.cache_clear()

    from src import main

    return importlib.reload(main).app


def _post(client, body):
    response = client.post("/", json=body, headers={"x-openbot-agent-token": TOKEN})
    assert response.status_code == 200
    assert [e["type"] for e in run_events(response.text) if e["type"].startswith("RUN_")] == [
        "RUN_STARTED",
        "RUN_FINISHED",
    ], response.text


def _system_text(body: dict) -> str:
    """Everything the provider request carries in a system position, as one string."""
    parts = [json.dumps(body.get("system", ""))]  # Anthropic Messages
    parts.append(json.dumps(body.get("instructions", "")))  # OpenAI Responses
    for message in [*(body.get("messages") or []), *(body.get("input") or [])]:
        if isinstance(message, dict) and message.get("role") in {"system", "developer"}:
            parts.append(json.dumps(message.get("content")))
    return "\n".join(parts)


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_a_fresh_process_answers_from_the_whole_thread_in_its_role(monkeypatch, environment):
    with fake_provider() as (base, bodies):
        with TestClient(_fresh_app(monkeypatch, environment, base)) as client:
            _post(client, conversation())
    assert bodies, "the model was never called"
    assert missing_from(bodies[-1]) == []
    assert STANDING_ROLE in _system_text(bodies[-1]), "the standing role is not a system message"
    assert GRANTED_TOOLS in _system_text(bodies[-1])


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_a_warm_process_answers_from_what_the_server_sends_now(monkeypatch, environment):
    """The second run on a thread carries a changed granted-tools summary under the same id.

    The server rewrites `granted-tools:<bot>` whenever a grant changes; the model must see the
    summary as it is now, and the thread once, whatever the process kept from the first run.
    """
    with fake_provider() as (base, bodies):
        # One client, so both runs share the app's event loop and its process memory.
        with TestClient(_fresh_app(monkeypatch, environment, base)) as client:
            _post(client, conversation(run_id="contract-run-1"))

            second = conversation(run_id="contract-run-2")
            second["messages"][1]["content"] = f"You hold these tools: {NEW_GRANTED_TOOLS}"
            assert second["messages"][1]["id"] == f"granted-tools:{BOT}"
            second["messages"] += [
                {"id": "a2", "role": "assistant", "content": "ok"},
                {"id": "u3", "role": "user", "content": f"And now? {NEWER_QUESTION}"},
            ]
            _post(client, second)
    assert len(bodies) == 2, "each run calls the model once"
    body = bodies[-1]
    sent = json.dumps(body)
    assert NEW_GRANTED_TOOLS in _system_text(body), "the changed granted-tools summary"
    assert GRANTED_TOOLS not in sent, "the stale granted-tools summary"
    assert STANDING_ROLE in _system_text(body), "the standing role is not a system message"
    for marker in (STANDING_ROLE, EARLIER_QUESTION, EARLIER_ANSWER, LATEST_QUESTION, NEWER_QUESTION):
        assert sent.count(marker) == 1, f"{marker} was sent {sent.count(marker)} times"
