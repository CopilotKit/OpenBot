"""A fresh Agno process answers from the whole thread the server sent, in the Bot's role.

See `shared/harness_contract.py` for what the contract is and why it is checked at the model.
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
    anthropic_environment,
    conversation,
    fake_provider,
    missing_from,
    openai_environment,
    run_events,
)

TOKEN = "contract-token"
PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def _run(monkeypatch, environment, body):
    with fake_provider() as (base, bodies):
        monkeypatch.delenv("OPENAI_API_BASE", raising=False)
        monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
        for key, value in environment(base).items():
            monkeypatch.setenv(key, value)

        from src import main

        main = importlib.reload(main)
        response = TestClient(main.app).post(
            "/agui", json=body, headers={"x-openbot-agent-token": TOKEN}
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


def test_an_earlier_tool_call_and_an_attached_image_are_part_of_the_thread(monkeypatch):
    run = conversation()
    run["messages"][2:2] = [
        {
            "id": "u0",
            "role": "user",
            "content": [
                {"type": "text", "text": "Look at this"},
                {"type": "image", "source": {"type": "data", "mimeType": "image/png", "value": PIXEL}},
            ],
        },
        {
            "id": "a0",
            "role": "assistant",
            "content": "",
            "toolCalls": [
                {"id": "call-0", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}
            ],
        },
        {"id": "t0", "role": "tool", "toolCallId": "call-0", "content": "TOOL_RESULT_MARKER"},
    ]
    body = _run(monkeypatch, openai_environment, run)
    assert missing_from(body) == []
    sent = json.dumps(body)
    assert "TOOL_RESULT_MARKER" in sent
    assert '"call-0"' in sent
    assert PIXEL in sent, "the image attached earlier in the thread reached the model"
