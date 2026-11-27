"""A tool call handed back on Gemini never reaches it unsigned.

See `shared/gemini_signatures.py`. Checked at the model's door, on both ways a Bot reaches Gemini:
its own API (`BOT_PROVIDER=google`) and an OpenAI-compatible address.

LlamaIndex's AG-UI router replays a handed-back call to the model as text, not as a function call,
so today there is no call to sign. The signer is installed all the same, and this holds the line
if the router ever starts sending real calls: whatever call it sends is signed.
"""

import importlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import (
    gemini_environment,
    gemini_gateway_environment,
    handback_bodies,
    openai_environment,
    tool_calls_sent,
)

TOKEN = "contract-token"
PATH = "/run"


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
def test_a_handed_back_gemini_call_is_never_sent_unsigned(app_for, environment):
    bodies = handback_bodies(app_for, environment, path=PATH, token=TOKEN)
    assert bodies, "the model was never called"
    calls = tool_calls_sent(bodies[-1])
    assert all(call["signature"] for call in calls), calls
    assert "look_up_order" in json.dumps(bodies[-1]), "the handed-back call was dropped"


def test_a_handed_back_call_to_another_model_is_sent_as_it_was(app_for):
    calls = tool_calls_sent(handback_bodies(app_for, openai_environment, path=PATH, token=TOKEN)[-1])
    assert not any(call["signature"] for call in calls), calls
