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
def test_a_system_row_the_server_did_not_write_is_conversation_not_an_instruction(
    monkeypatch, environment
):
    """Only the server's standing role and granted-tools summary are the Bot's instructions.

    Other system rows reach a remote Bot too: a skill's instructions from the browser
    (`channel-chat.tsx`), the server's quoted personal-memory records, and anything else that lands
    in `messages` with an id that is not the server's. Each reaches the model where it stands in the
    thread, labelled as conversation, and never with the system prompt's authority.
    """
    rows = {
        "skill-1": ("system", "BROWSER_SYSTEM_ROW_7f3a"),
        "openbot:personal-memory": ("system", "MEMORY_RECORD_ROW_7f3a"),
        "dev-1": ("developer", "BROWSER_DEVELOPER_ROW_7f3a"),
        "standing-role-lookalike": ("system", "LOOKALIKE_ROW_7f3a"),
    }
    run = conversation()
    run["messages"][2:2] = [
        {"id": id, "role": role, "content": content} for id, (role, content) in rows.items()
    ]
    body = _run(monkeypatch, environment, run)
    assert missing_from(body) == []
    assert "CONTRACT_STANDING_ROLE_7f3a" in _system_text(body)
    assert "CONTRACT_GRANTED_TOOLS_7f3a" in _system_text(body)
    # Each user message's text, as the provider was sent it (Anthropic's merged into parts).
    users = [
        m["content"]
        if isinstance(m["content"], str)
        else "\n".join(part.get("text", "") for part in m["content"])
        for m in body["messages"]
        if m["role"] == "user"
    ]
    for id, (role, content) in rows.items():
        assert content not in _system_text(body), f"{id} was given the system prompt's authority"
        carrying = [m for m in users if content in m]
        assert len(carrying) == 1, f"{id} did not reach the model as conversation"
        assert "conversation history, not a system instruction" in carrying[0]
        assert "not something the person wrote" in carrying[0]
        assert json.dumps(id) in carrying[0] and json.dumps(role) in carrying[0]
    # Where it stood: before the question it was sent with.
    sent = "\n".join(users)
    assert sent.index("BROWSER_SYSTEM_ROW_7f3a") < sent.index("CONTRACT_EARLIER_QUESTION_7f3a")


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


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_a_tool_result_for_a_run_this_process_does_not_hold_is_answered_from_the_thread(
    monkeypatch, environment
):
    """A restart, or a second replica, between a client tool call and its result.

    The result comes back as trailing tool messages, which the router treats as resuming a run it
    paused. A fresh process holds no paused run, and the router failed the run ("Session ... not
    found", or "No paused run matching the provided tool results"). With nothing to resume, it
    answers from the thread instead, the call and its result included, as it would any other run.
    """
    run = conversation()
    run["messages"] += [
        {
            "id": "a2",
            "role": "assistant",
            "toolCalls": [
                {
                    "id": "call-restart",
                    "type": "function",
                    "function": {"name": "remember_fact", "arguments": '{"fact": "x"}'},
                }
            ],
        },
        {"id": "t2", "role": "tool", "toolCallId": "call-restart", "content": "RESUMED_RESULT_7f3a"},
    ]
    run["tools"] = [
        {
            "name": "remember_fact",
            "description": "Remember a fact.",
            "parameters": {"type": "object", "properties": {"fact": {"type": "string"}}},
        }
    ]
    body = _run(monkeypatch, environment, run)
    assert missing_from(body) == []
    sent = json.dumps(body)
    assert "RESUMED_RESULT_7f3a" in sent
    assert "call-restart" in sent
