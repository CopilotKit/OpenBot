"""A long thread replays its newest messages, and the process does not keep what it replayed.

Before the harness read the whole thread, a run carried one message: it could not outgrow the
model's context window, and the run Agno stored was that one message. Sent whole on every turn, a
long thread would fail every turn once it outgrew the window, and a store that kept every run would
hold the thread once per turn, for as long as the process lives.
"""

import importlib
import json
import sys
from pathlib import Path

from agno.db.base import SessionType
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import conversation, fake_provider, openai_environment, run_events

TOKEN = "contract-token"
# The most the contract model replays, in characters: litellm does not know `contract-model`, so it
# gets `REPLAY_BUDGET_TOKENS` (100K) at `CHARS_PER_TOKEN` (2.5). Written out so a change to either
# is a change to this test too.
BUDGET_CHARS = 250_000


def _runs(monkeypatch, *bodies):
    with fake_provider() as (base, seen):
        monkeypatch.delenv("OPENAI_API_BASE", raising=False)
        monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
        for key, value in openai_environment(base).items():
            monkeypatch.setenv(key, value)

        from src import main

        main = importlib.reload(main)
        client = TestClient(main.app)
        for body in bodies:
            response = client.post("/agui", json=body, headers={"x-openbot-agent-token": TOKEN})
            assert response.status_code == 200
            types = [e["type"] for e in run_events(response.text) if e["type"].startswith("RUN_")]
            assert types == ["RUN_STARTED", "RUN_FINISHED"], response.text
    return main, seen


def _thread(*turns):
    run = conversation()
    run["messages"] = run["messages"][:2] + [
        {"id": f"m{index}", "role": role, "content": content, **extra}
        for index, (role, content, extra) in enumerate(
            turn if len(turn) == 3 else (*turn, {}) for turn in turns
        )
    ]
    return run


def _sent(seen):
    return json.dumps(seen[-1])


def _shown(sent: str, *markers: str) -> dict[str, bool]:
    """Which markers the request carries. Compared as a dict, so a failure names the marker and
    pytest does not diff a request of a million characters."""
    return {marker: marker in sent for marker in markers}


def test_a_thread_over_the_budget_replays_its_newest_messages(monkeypatch):
    turns = []
    for index in range(400):
        turns.append(("user", f"QUESTION_{index:03d} " + "q" * 2000))
        turns.append(("assistant", f"ANSWER_{index:03d} " + "a" * 2000))
    turns.append(("user", "LATEST_QUESTION"))
    _, seen = _runs(monkeypatch, _thread(*turns))
    sent = _sent(seen)
    # The role and the tools are never what gives way, and the Bot is told it is not the whole
    # thread.
    assert _shown(
        sent,
        "LATEST_QUESTION",
        "ANSWER_399",
        "QUESTION_000",
        "CONTRACT_STANDING_ROLE_7f3a",
        "CONTRACT_GRANTED_TOOLS_7f3a",
        "not shown",
    ) == {
        "LATEST_QUESTION": True,
        "ANSWER_399": True,
        "QUESTION_000": False,
        "CONTRACT_STANDING_ROLE_7f3a": True,
        "CONTRACT_GRANTED_TOOLS_7f3a": True,
        "not shown": True,
    }
    assert len(sent) < 2 * BUDGET_CHARS, len(sent)
    # Before the history starts.
    assert sent.index("not shown") < sent.index("QUESTION_")


def test_the_bound_never_separates_a_tool_call_from_its_result(monkeypatch):
    budget = BUDGET_CHARS
    call = {
        "id": "call-big",
        "type": "function",
        "function": {"name": "lookup", "arguments": json.dumps({"q": "x" * int(budget * 0.3)})},
    }
    _, seen = _runs(
        monkeypatch,
        _thread(
            ("user", "OLD_QUESTION"),
            ("user", "TOOL_QUESTION"),
            # Newest first, the result fits the budget and its call does not: keeping the newest
            # messages that fit would keep a result whose call is gone.
            ("assistant", "", {"toolCalls": [call]}),
            ("tool", "RESULT_BIG " + "r" * int(budget * 0.8), {"toolCallId": "call-big"}),
            ("assistant", "AFTER_TOOL"),
            ("user", "LATEST_QUESTION"),
        ),
    )
    # The answer after the tool goes too, because a replay opens with a question.
    assert _shown(
        _sent(seen),
        "LATEST_QUESTION",
        "AFTER_TOOL",
        "RESULT_BIG",
        "call-big",
        "OLD_QUESTION",
        "not shown",
    ) == {
        "LATEST_QUESTION": True,
        "AFTER_TOOL": False,
        "RESULT_BIG": False,
        "call-big": False,
        "OLD_QUESTION": False,
        "not shown": True,
    }


def test_the_bound_keeps_everything_from_the_latest_user_message_on(monkeypatch):
    """The person's newest message, and the tool calls and results a turn has made since, are what
    the Bot is answering. They are replayed whole even when they alone are over the budget."""
    budget = BUDGET_CHARS
    call = {
        "id": "call-tail",
        "type": "function",
        "function": {"name": "lookup", "arguments": "{}"},
    }
    _, seen = _runs(
        monkeypatch,
        _thread(
            ("user", "OLD_QUESTION"),
            ("assistant", "OLD_ANSWER"),
            ("user", "LATEST_QUESTION " + "l" * int(budget * 0.6)),
            ("assistant", "", {"toolCalls": [call]}),
            ("tool", "TAIL_RESULT " + "t" * int(budget * 0.6), {"toolCallId": "call-tail"}),
            ("assistant", "TAIL_ANSWER"),
        ),
    )
    kept = ("LATEST_QUESTION", "call-tail", "TAIL_RESULT", "TAIL_ANSWER", "not shown")
    gone = ("OLD_QUESTION", "OLD_ANSWER")
    assert _shown(_sent(seen), *kept, *gone) == {
        **{marker: True for marker in kept},
        **{marker: False for marker in gone},
    }


def test_the_replay_starts_on_a_question(monkeypatch):
    """Anthropic and Gemini refuse a conversation that opens with the assistant."""
    question = "q" * int(BUDGET_CHARS * 0.4)
    _, seen = _runs(
        monkeypatch,
        _thread(
            ("user", "Q1 " + question),
            ("assistant", "A1"),
            ("user", "Q2 " + question),
            ("assistant", "A2"),
            ("user", "Q3 " + question),
            ("assistant", "A3"),
            ("user", "LATEST_QUESTION"),
        ),
    )
    conversation = [m for m in seen[-1]["messages"] if m["role"] != "system"]
    assert conversation[0]["role"] == "user"
    assert conversation[0]["content"].startswith("Q2 ")


def test_the_budget_is_half_the_models_window_and_never_more_than_the_cap():
    from src.conversation import CHARS_PER_TOKEN, REPLAY_BUDGET_TOKENS, replay_budget

    assert REPLAY_BUDGET_TOKENS * CHARS_PER_TOKEN == BUDGET_CHARS
    # litellm's own registry: gpt-4o-mini takes 128K, so a 100K replay would leave it no room.
    assert replay_budget("openai/gpt-4o-mini") == 64_000
    assert replay_budget("openai/gpt-5.5") == REPLAY_BUDGET_TOKENS
    # An endpoint's own model, which litellm has never heard of.
    assert replay_budget("openai/qwen/qwen3-8b") == REPLAY_BUDGET_TOKENS


def test_the_store_keeps_no_finished_run(monkeypatch):
    """A run that finished is never read back, and each one now carries the whole thread."""
    first = conversation(run_id="run-1")
    second = conversation(run_id="run-2")
    second["messages"] += [
        {"id": "a2", "role": "assistant", "content": "ok"},
        {"id": "u3", "role": "user", "content": "And again?"},
    ]
    main, _ = _runs(monkeypatch, first, second)
    session = main.agent.db.get_session(
        session_id="contract-thread", session_type=SessionType.AGENT
    )
    assert session is not None, "the session itself is kept: it is what a thread's runs belong to"
    assert not session.runs
