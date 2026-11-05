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


def _system_text(body) -> str:
    """Everything the request gives system authority: OpenAI's system messages, Anthropic's `system`."""
    messages = [m for m in body.get("messages", []) if m.get("role") in ("system", "developer")]
    return json.dumps(messages) + json.dumps(body.get("system", ""))


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_a_system_row_the_server_did_not_write_is_not_made_an_instruction(monkeypatch, environment):
    """Only the server's standing role and granted-tools summary are the Bot's instructions.

    The browser writes system rows too (a skill's instructions, `channel-chat.tsx`), and so can
    anything else that reaches `messages`. Before this harness read the thread none of them reached
    the model, and none may now arrive with the system prompt's authority.
    """
    run = conversation()
    run["messages"][2:2] = [
        {"id": "skill-1", "role": "system", "content": "BROWSER_SYSTEM_ROW_7f3a"},
        {"id": "dev-1", "role": "developer", "content": "BROWSER_DEVELOPER_ROW_7f3a"},
        {"id": "standing-role-lookalike", "role": "system", "content": "LOOKALIKE_ROW_7f3a"},
    ]
    body = _run(monkeypatch, environment, run)
    assert missing_from(body) == []
    sent = json.dumps(body)
    for row in ("BROWSER_SYSTEM_ROW_7f3a", "BROWSER_DEVELOPER_ROW_7f3a", "LOOKALIKE_ROW_7f3a"):
        assert row not in sent, f"{row} reached the model"
    assert "CONTRACT_STANDING_ROLE_7f3a" in _system_text(body)
    assert "CONTRACT_GRANTED_TOOLS_7f3a" in _system_text(body)


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_the_runs_context_still_reaches_the_model_on_the_newest_question(monkeypatch, environment):
    """The server sends a Bot's learned skills and the person's memory as AG-UI `context`.

    Agno adds a run's context only to a user message it builds itself, so a run given a list of
    messages would drop it. It goes where Agno put it before: on the newest question.
    """
    run = conversation()
    run["context"] = [{"description": "OpenBot personal memory", "value": "RUN_CONTEXT_7f3a"}]
    body = _run(monkeypatch, environment, run)
    assert missing_from(body) == []
    users = [m for m in body["messages"] if m["role"] == "user"]
    assert "RUN_CONTEXT_7f3a" in json.dumps(users[-1])
    assert "CONTRACT_LATEST_QUESTION_7f3a" in json.dumps(users[-1])
    assert "RUN_CONTEXT_7f3a" not in _system_text(body)


def test_a_tool_result_made_of_parts_is_replayed_as_its_text(monkeypatch):
    """ag-ui-protocol 1.0 lets a tool result be a list of content parts."""
    run = conversation()
    run["messages"][2:2] = [
        {"id": "u0", "role": "user", "content": "Look it up"},
        {
            "id": "a0",
            "role": "assistant",
            "toolCalls": [
                {"id": "call-0", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}
            ],
        },
        {
            "id": "t0",
            "role": "tool",
            "toolCallId": "call-0",
            "content": [{"type": "text", "text": "TOOL_PART_MARKER_7f3a"}],
        },
    ]
    body = _run(monkeypatch, openai_environment, run)
    assert missing_from(body) == []
    assert "TOOL_PART_MARKER_7f3a" in json.dumps(body)
