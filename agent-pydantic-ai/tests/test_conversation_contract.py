"""A fresh Pydantic AI process answers from the whole thread the server sent, in the Bot's role.

See `shared/harness_contract.py` for what the contract is and why it is checked at the model.
"""

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import (
    anthropic_environment,
    check_gateway_keys,
    conversation,
    fake_provider,
    missing_from,
    openai_environment,
    run_events,
)

TOKEN = "contract-token"


def _run(monkeypatch, environment, body):
    with fake_provider() as (base, bodies):
        monkeypatch.delenv("OPENAI_API_BASE", raising=False)
        monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
        monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
        monkeypatch.setenv("PYDANTIC_AI_NO_BANNER", "1")
        for key, value in environment(base).items():
            monkeypatch.setenv(key, value)

        from src import main

        main = importlib.reload(main)
        response = TestClient(main.app).post(
            "/", json=body, headers={"x-openbot-agent-token": TOKEN}
        )
    assert response.status_code == 200
    assert [e["type"] for e in run_events(response.text) if e["type"].startswith("RUN_")] == [
        "RUN_STARTED",
        "RUN_FINISHED",
    ], response.text
    assert bodies, "the model was never called"
    return bodies[-1]


@pytest.mark.parametrize("wire", ["openai", "anthropic"])
def test_a_run_calls_the_gateway_with_its_own_key(monkeypatch, wire):
    """The run's own gateway token, in its organization; the environment's without one.

    See `shared/run_model_key.py`.
    """

    def app_for(environment):
        monkeypatch.delenv("OPENAI_API_BASE", raising=False)
        monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
        monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
        monkeypatch.setenv("PYDANTIC_AI_NO_BANNER", "1")
        for key, value in environment.items():
            monkeypatch.setenv(key, value)
        from src import main

        return importlib.reload(main).app

    check_gateway_keys(app_for, wire, token=TOKEN)


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_a_fresh_process_answers_from_the_whole_thread_in_its_role(monkeypatch, environment):
    assert missing_from(_run(monkeypatch, environment, conversation())) == []
