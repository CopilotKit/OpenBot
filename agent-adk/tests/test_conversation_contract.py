"""An ADK Bot answers from the whole thread the server sent, in the Bot's role.

See `shared/harness_contract.py` for what the contract is and why it is checked at the model.
`ag_ui_adk` keeps an ADK session per thread and sends the model only what that session has not
seen yet, so beyond the fresh process this checks the two ways a warm one can drift from the
thread: the session expiring while the process stays up, and the role changing between runs.
"""

import asyncio
import importlib
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import (
    BOT,
    EARLIER_QUESTION,
    GRANTED_TOOLS,
    LATEST_QUESTION,
    anthropic_environment,
    conversation,
    fake_provider,
    missing_from,
    openai_environment,
    run_events,
)

TOKEN = "contract-token"
NEWER_QUESTION = "CONTRACT_NEWER_QUESTION_adk"
NEW_GRANT = "CONTRACT_NEW_GRANT_adk"


def _app(monkeypatch, environment, base):
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    for key, value in environment(base).items():
        monkeypatch.setenv(key, value)
    from src import main

    return importlib.reload(main)


def _session_manager(main):
    """The manager holding this app's sessions: its own, or the process-wide default."""
    agent = getattr(main, "agent", None)
    if agent is not None:
        return agent._session_manager
    from ag_ui_adk.session_manager import SessionManager

    return SessionManager.get_default()


async def _post(client, body):
    response = await client.post("/", json=body, headers={"x-openbot-agent-token": TOKEN})
    assert response.status_code == 200
    events = run_events(response.text)
    assert [e["type"] for e in events if e["type"].startswith("RUN_")] == [
        "RUN_STARTED",
        "RUN_FINISHED",
    ], response.text
    return events


def _answer(events, after):
    """The assistant message the harness just sent, as the server would store it in the thread."""
    started = [e for e in events if e["type"] == "TEXT_MESSAGE_START"]
    assert started, events
    text = "".join(e["delta"] for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")
    return [
        *after,
        {"id": started[-1]["messageId"], "role": "assistant", "content": text},
    ]


def _two_turns(monkeypatch, thread, between=None, second=None):
    """Run the contract conversation, then the next turn on the same thread, in one process.

    `between(main)` runs between the turns; `second(messages)` edits the second run's thread.
    Returns the body the model received on the second turn.
    """
    with fake_provider() as (base, bodies):
        main = _app(monkeypatch, openai_environment, base)

        async def turns():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://harness"
            ) as client:
                first = conversation(thread_id=thread, run_id=f"{thread}-1")
                events = await _post(client, first)
                assert bodies, "the model was never called"
                assert missing_from(bodies[-1]) == []
                if between is not None:
                    await between(main)
                messages = _answer(events, first["messages"]) + [
                    {"id": "u3", "role": "user", "content": f"And now? {NEWER_QUESTION}"}
                ]
                if second is not None:
                    second(messages)
                called = len(bodies)
                await _post(client, {**first, "runId": f"{thread}-2", "messages": messages})
                assert len(bodies) > called, "the model was not called for the second turn"
                return bodies[-1]

        return asyncio.run(asyncio.wait_for(turns(), timeout=60))


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_a_fresh_process_answers_from_the_whole_thread_in_its_role(monkeypatch, environment):
    with fake_provider() as (base, bodies):
        main = _app(monkeypatch, environment, base)

        async def run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://harness"
            ) as client:
                await _post(client, conversation(thread_id=f"fresh-{environment.__name__}"))

        asyncio.run(asyncio.wait_for(run(), timeout=60))
    assert bodies, "the model was never called"
    assert missing_from(bodies[-1]) == []


def test_a_warm_process_answers_the_next_turn_from_the_whole_thread(monkeypatch):
    body = _two_turns(monkeypatch, "warm-thread")
    assert missing_from(body) == []
    assert NEWER_QUESTION in json.dumps(body)


def test_an_expired_session_does_not_cost_the_thread_its_history(monkeypatch):
    """The sweeper deletes a session idle past its timeout while the process stays up."""

    async def expire(main):
        from ag_ui_adk import session_manager as module

        manager = _session_manager(main)
        assert manager.get_session_count() > 0, "turn 1 left no session to expire"
        later = time.time() + (manager._timeout or 0) + 3600
        monkeypatch.setattr(module, "time", SimpleNamespace(time=lambda: later))
        # The function the cleanup loop calls every `cleanup_interval_seconds`.
        await manager._cleanup_expired_sessions()
        assert manager.get_session_count() == 0, "the sweeper kept the idle session"
        monkeypatch.setattr(module, "time", time)

    body = _two_turns(monkeypatch, "evicted-thread", between=expire)
    assert missing_from(body) == []
    assert NEWER_QUESTION in json.dumps(body)


def test_a_changed_grant_reaches_the_model_on_the_next_run(monkeypatch):
    """Same `granted-tools:<bot>` id, new content: the model is told what the Bot holds now."""

    def regrant(messages):
        grant = next(m for m in messages if m["id"] == f"granted-tools:{BOT}")
        grant["content"] = f"You hold these tools: {NEW_GRANT}"

    body = _two_turns(monkeypatch, "regrant-thread", second=regrant)
    sent = json.dumps(body)
    assert NEW_GRANT in sent
    assert GRANTED_TOOLS not in sent, "the model was still shown the grant it no longer holds"
    assert NEWER_QUESTION in sent


MISSED_QUESTION = "CONTRACT_MISSED_QUESTION_7f3a"


def test_a_turn_answered_elsewhere_reaches_a_live_session(monkeypatch):
    """Another replica answered a turn this process's session never saw."""

    def answered_elsewhere(messages):
        messages[-1:-1] = [
            {"id": "u2b", "role": "user", "content": f"Something else. {MISSED_QUESTION}"},
            {"id": "a2b", "role": "assistant", "content": "Answered by another replica."},
        ]

    body = _two_turns(monkeypatch, "missed-thread", second=answered_elsewhere)
    sent = json.dumps(body)
    assert MISSED_QUESTION in sent, "the turn this session never saw reached the model"
    assert missing_from(body) == []
    for marker in (EARLIER_QUESTION, LATEST_QUESTION, NEWER_QUESTION, MISSED_QUESTION):
        assert sent.count(marker) == 1, (marker, sent)


def test_a_live_session_is_not_rebuilt_on_every_turn(monkeypatch):
    """A healthy session keeps answering; only a session that missed a turn starts again."""
    deleted = []

    def watch(main):
        manager = _session_manager(main)
        original = manager._delete_session

        async def recording(session):
            deleted.append(session.id)
            await original(session)

        monkeypatch.setattr(manager, "_delete_session", recording)

    async def between(main):
        watch(main)

    _two_turns(monkeypatch, "healthy-thread", between=between)
    assert deleted == []
