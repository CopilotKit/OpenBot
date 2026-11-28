"""A fresh Microsoft Agent Framework process answers from the whole thread the server sent, in the Bot's role.

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
    check_run_keys,
    conversation,
    fake_provider,
    gateway_environment,
    missing_from,
    openai_environment,
    run_events,
    with_run_key,
)

TOKEN = "contract-token"


def _run(monkeypatch, environment, body):
    with fake_provider() as (base, bodies):
        monkeypatch.delenv("OPENAI_API_BASE", raising=False)
        monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
        monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
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


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_a_fresh_process_answers_from_the_whole_thread_in_its_role(monkeypatch, environment):
    assert missing_from(_run(monkeypatch, environment, conversation())) == []


@pytest.mark.parametrize("wire", ["openai", "anthropic"])
def test_a_run_calls_the_gateway_with_its_own_key(monkeypatch, wire):
    """The run's own gateway token, in its organization, for that run; the environment's otherwise.

    See `shared/run_model_key.py`.
    """
    keys: list[str] = []
    with fake_provider(keys) as (base, bodies):
        monkeypatch.delenv("OPENAI_API_BASE", raising=False)
        monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
        monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
        for key, value in gateway_environment(wire)(base).items():
            monkeypatch.setenv(key, value)

        from src import main

        # One event loop for both runs, as the server process has: the SDK keeps its client.
        with TestClient(importlib.reload(main).app) as client:
            for body in (with_run_key(conversation(), wire), conversation(run_id="contract-run-2")):
                response = client.post("/", json=body, headers={"x-openbot-agent-token": TOKEN})
                assert response.status_code == 200
                assert "RUN_FINISHED" in response.text, response.text
                if "openbotModelRoute" in body["forwardedProps"]:
                    ran_with_token = len(keys)
    check_run_keys(keys, ran_with_token, bodies)
