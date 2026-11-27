"""A tool call handed back on Gemini reaches it signed; on any other model, as it was.

See `shared/gemini_signatures.py`. Checked at the model's door, on both ways a Bot reaches Gemini:
its own API (`BOT_PROVIDER=google`) and an OpenAI-compatible address.
"""

import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import (
    check_handback_signed,
    gemini_environment,
    gemini_gateway_environment,
    handback_bodies,
    openai_environment,
    tool_calls_sent,
)

TOKEN = "contract-token"


@pytest.fixture
def app_for(monkeypatch):
    def app_for(environment):
        monkeypatch.delenv("OPENAI_API_BASE", raising=False)
        monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
        monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
        for key, value in environment.items():
            monkeypatch.setenv(key, value)
        from src import main

        return importlib.reload(main).app

    return app_for


@pytest.mark.parametrize("environment", [gemini_environment, gemini_gateway_environment])
def test_a_handed_back_gemini_call_is_signed(app_for, environment):
    check_handback_signed(handback_bodies(app_for, environment, token=TOKEN))


def test_a_handed_back_call_to_another_model_is_sent_as_it_was(app_for):
    calls = tool_calls_sent(handback_bodies(app_for, openai_environment, token=TOKEN)[-1])
    assert calls, "the handed-back call never reached the model as a call"
    assert not any(call["signature"] for call in calls), calls

