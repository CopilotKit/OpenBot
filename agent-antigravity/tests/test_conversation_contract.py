"""A fresh Antigravity process answers from the whole thread the server sent, in the Bot's role.

See `shared/harness_contract.py` for what the contract is and why it is checked at the model.

The model is not called from Python here. `ag_ui_antigravity` drives the Go `localharness` the SDK
wheel bundles, and it is that binary which builds the request and sends it to the Gemini API. So
the check runs the real binary, pointed by `GOOGLE_GENERATIVE_AI_BASE_URL` at a fake Gemini on
localhost, and reads the body the harness posts to `:streamGenerateContent`. `fake_provider()`
speaks OpenAI and Anthropic only, so the Gemini stand-in lives here. Nothing this Bot or the
integration does in Python can make the check pass unless the harness really sent the text on.

A later turn carries the ids the harness streamed on the turn before, because that is what the
browser files the Bot's messages under and what the server sends back.
"""

import asyncio
import importlib
import json
import socket
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import (
    EARLIER_QUESTION,
    LATEST_QUESTION,
    STANDING_ROLE,
    conversation,
    missing_from,
    run_events,
)

TOKEN = "contract-token"
NEXT_QUESTION = "CONTRACT_NEXT_QUESTION_7f3a"
CHANGED_ROLE = "CONTRACT_CHANGED_ROLE_7f3a"


def _answer(*parts) -> dict:
    return {
        "candidates": [
            {
                "content": {"role": "model", "parts": list(parts) or [{"text": "ok"}]},
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
    }


@contextmanager
def fake_gemini(replies=(), slow=None):
    """A Gemini API on localhost that records every generate request body.

    It answers with `replies` in order, then "ok". A request whose body contains `slow` is
    answered two seconds late, so a test can send a second run while the first is still streaming.
    """
    import uvicorn
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, StreamingResponse

    bodies: list[dict] = []
    queued = list(replies)
    app = FastAPI()

    @app.post("/v1beta/models/{call}")
    async def generate(call: str, request: Request):
        body = await request.json()
        bodies.append(body)
        answer = queued.pop(0) if queued else _answer()
        if slow and slow in json.dumps(body):
            await asyncio.sleep(2)
        if call.endswith(":streamGenerateContent"):

            async def stream():
                yield f"data: {json.dumps(answer)}\r\n\r\n"

            return StreamingResponse(stream(), media_type="text/event-stream")
        return JSONResponse(answer)

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    try:
        yield f"http://127.0.0.1:{port}", bodies
    finally:
        server.should_exit = True
        thread.join(timeout=10)


@contextmanager
def fresh_bot(monkeypatch, tmp_path, replies=(), slow=None):
    """A newly imported app, as a restarted container has, on its own harness and home.

    Yields `run(body)`, which posts one run and returns the last request the model received;
    `run.events` holds each run's AG-UI events and `run.bodies` every request in order.
    """
    with fake_gemini(replies, slow) as (base, bodies):
        # The harness keeps its app data under $HOME; a test must not read or leave any there.
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
        monkeypatch.setenv("GOOGLE_API_KEY", "contract-key")
        monkeypatch.setenv("GOOGLE_GENERATIVE_AI_BASE_URL", base)
        monkeypatch.delenv("BOT_PROVIDER", raising=False)
        monkeypatch.delenv("BOT_MODEL", raising=False)
        from src import main

        main = importlib.reload(main)
        with TestClient(main.app) as client:

            def post(body):
                response = client.post("/", json=body, headers={"x-openbot-agent-token": TOKEN})
                assert response.status_code == 200
                return run_events(response.text)

            def run(body):
                before = len(bodies)
                events = post(body)
                run.events.append(events)
                assert [e["type"] for e in events if e["type"].startswith("RUN_")] == [
                    "RUN_STARTED",
                    "RUN_FINISHED",
                ], events
                assert len(bodies) > before, "the model was never called"
                return bodies[-1]

            run.events = []
            run.bodies = bodies
            run.post = post
            yield run


def _system_instruction(body: dict) -> str:
    return json.dumps(body.get("systemInstruction", {}))


def _user_turn(body: dict) -> str:
    """The text of the newest user turn the model was sent."""
    turn = [content for content in body["contents"] if content.get("role") == "user"][-1]
    return "".join(part.get("text", "") for part in turn["parts"])


def _said(events: list[dict]) -> str:
    """The id of the text message a run streamed: the id the browser keeps the reply under."""
    return next(e["messageId"] for e in events if e["type"] == "TEXT_MESSAGE_START")


def _next_turn(run: dict, reply: str, *, role: str | None = None) -> dict:
    """The same thread one turn later, the way the server sends it: everything again, plus more."""
    following = json.loads(json.dumps(run))
    following["runId"] = "contract-run-2"
    if role is not None:
        following["messages"][0]["content"] = f"You are Contract Bot. {role}"
    following["messages"] += [
        {"id": reply, "role": "assistant", "content": "ok"},
        {"id": "u3", "role": "user", "content": f"And after that? {NEXT_QUESTION}"},
    ]
    return following


def test_a_fresh_process_answers_from_the_whole_thread_in_its_role(monkeypatch, tmp_path):
    with fresh_bot(monkeypatch, tmp_path) as run:
        body = run(conversation())
    assert missing_from(body) == []
    assert STANDING_ROLE in _system_instruction(body), "the standing role is a system instruction"


def test_a_live_session_is_not_sent_the_history_twice(monkeypatch, tmp_path):
    first = conversation()
    with fresh_bot(monkeypatch, tmp_path) as run:
        run(first)
        body = run(_next_turn(first, _said(run.events[0])))
    assert missing_from(body) == []
    sent = json.dumps(body)
    assert NEXT_QUESTION in sent
    assert sent.count(EARLIER_QUESTION) == 1, sent
    assert sent.count(LATEST_QUESTION) == 1, sent


def test_a_changed_standing_role_reaches_the_next_run(monkeypatch, tmp_path):
    first = conversation()
    with fresh_bot(monkeypatch, tmp_path) as run:
        run(first)
        body = run(_next_turn(first, _said(run.events[0]), role=CHANGED_ROLE))
    assert CHANGED_ROLE in _system_instruction(body)
    assert STANDING_ROLE not in json.dumps(body)
    sent = json.dumps(body)
    for marker in (EARLIER_QUESTION, LATEST_QUESTION, NEXT_QUESTION):
        assert sent.count(marker) == 1, (marker, sent)


SKILL = "CONTRACT_SKILL_INSTRUCTIONS_7f3a"
MEMORY = "CONTRACT_PERSONAL_MEMORY_7f3a"


def _skill(content: str = SKILL, id: str = "skill-receipts") -> dict:
    return {"id": id, "role": "system", "content": content}


def _labelled(row: dict) -> str:
    """How a system row reads in what the model is sent: an entry labelled with its role."""
    return json.dumps(row)


def test_other_system_rows_reach_the_model_as_labelled_data(monkeypatch, tmp_path):
    """A skill's instructions from the browser, and the server's memory record, are conversation.

    The server writes the two system messages that carry an id it reserves, and drops any incoming
    message that claims one. Only those become instructions. Every other system row reaches the
    model, labelled with its role, and gains no system authority.
    """
    run = conversation()
    memory = {"id": "openbot:personal-memory", "role": "system", "content": MEMORY}
    run["messages"].insert(2, memory)
    run["messages"].insert(-1, _skill())
    with fresh_bot(monkeypatch, tmp_path) as send:
        body = send(run)
    assert missing_from(body) == []
    assert STANDING_ROLE in _system_instruction(body)
    for row in (_skill(), memory):
        assert row["content"] not in _system_instruction(body), "a system row became an instruction"
        assert _labelled(row) in _user_turn(body), (row["id"], "never reached the model as data")


def test_a_skill_on_a_later_turn_reaches_a_live_session_as_labelled_data(monkeypatch, tmp_path):
    """The skill a person picks goes in front of their message, on a session already running."""
    first = conversation()
    with fresh_bot(monkeypatch, tmp_path) as run:
        run(first)
        following = _next_turn(first, _said(run.events[0]))
        following["messages"].insert(-1, _skill(id="skill-on-turn-3"))
        body = run(following)
    assert "model" in [content.get("role") for content in body["contents"]], "the session was rebuilt"
    assert SKILL not in _system_instruction(body), "the skill became an instruction"
    turn = _user_turn(body)
    assert _labelled(_skill(id="skill-on-turn-3")) in turn and NEXT_QUESTION in turn, turn
    assert json.dumps(body).count(SKILL) == 1


PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def test_an_earlier_tool_call_and_an_attached_image_are_part_of_the_thread(monkeypatch, tmp_path):
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
    with fresh_bot(monkeypatch, tmp_path) as send:
        body = send(run)
    assert missing_from(body) == []
    sent = json.dumps(body)
    assert "TOOL_RESULT_MARKER" in sent
    assert "call-0" in sent
    assert PIXEL in sent, "the image attached earlier in the thread reached the model"


FIRST_WORDS = "CONTRACT_FIRST_WORDS_7f3a"


def test_a_long_thread_is_seeded_with_its_newest_messages_and_the_question(monkeypatch, tmp_path):
    """About 2.4M characters, far over what the harness takes in one user turn.

    `localharness` keeps the first 192,000 bytes of a user turn and cuts the rest. Seeded whole, a
    thread longer than that reached the model without its newest messages and without the question
    the run was asked, after every restart, on every other replica, and after every change of role
    or tools.
    """
    run = conversation()
    filler = "x" * 2_000
    history = [{"id": "u-first", "role": "user", "content": f"{FIRST_WORDS} {filler}"}]
    for index in range(600):
        history += [
            {"id": f"u-{index}", "role": "user", "content": f"{index} {filler}"},
            {"id": f"a-{index}", "role": "assistant", "content": f"{index} {filler}"},
        ]
    memory = {"id": "openbot:personal-memory", "role": "system", "content": MEMORY}
    run["messages"][2:2] = [memory, *history]
    with fresh_bot(monkeypatch, tmp_path) as send:
        body = send(run)
    turn = _user_turn(body)
    assert LATEST_QUESTION in turn, "the question this run was asked never reached the model"
    assert _labelled(memory) in turn, "the memory record ahead of the thread was left out"
    assert EARLIER_QUESTION in turn
    assert "<truncated" not in turn, turn[-300:]
    assert FIRST_WORDS not in turn, "the oldest message was replayed past the budget"
    assert "Earlier messages in this conversation are not shown" in turn
    assert STANDING_ROLE in _system_instruction(body)


def test_a_thread_with_more_images_than_the_model_takes_is_seeded_with_the_newest(
    monkeypatch, tmp_path
):
    """Three hundred images, say a computer Bot's screenshots, at about 1,122 tokens each.

    Seeded whole, that is one step of about 340,000 tokens, which the harness refuses outright
    (its own limit is 256,000), so every run that built a session failed. The oldest images are
    left out, as text is.
    """
    run = conversation()
    run["messages"][2:2] = [
        {
            "id": f"u-image-{index}",
            "role": "user",
            "content": [
                {"type": "text", "text": f"IMAGE_{index:04d}"},
                {"type": "image", "source": {"type": "data", "mimeType": "image/png", "value": PIXEL}},
            ],
        }
        for index in range(300)
    ]
    with fresh_bot(monkeypatch, tmp_path) as send:
        body = send(run)
    sent = json.dumps(body)
    assert "IMAGE_0299" in sent and LATEST_QUESTION in sent
    assert "IMAGE_0000" not in sent
    assert sent.count(PIXEL) <= 128_000 // 1_122, sent.count(PIXEL)
    assert "Earlier messages in this conversation are not shown" in sent


def test_the_seed_never_separates_a_tool_call_from_its_result():
    """The pure rule, on the shapes a real thread has: a call, its result, the newest question."""
    from ag_ui.core import AssistantMessage, FunctionCall, ToolCall, ToolMessage, UserMessage

    from src.whole_thread import replay_start

    call = ToolCall(id="call-1", type="function", function=FunctionCall(name="lookup", arguments="{}"))
    messages = [
        UserMessage(id="u1", role="user", content="old"),
        AssistantMessage(id="a1", role="assistant", tool_calls=[call]),
        ToolMessage(id="t1", role="tool", tool_call_id="call-1", content="result"),
        AssistantMessage(id="a2", role="assistant", content="answer"),
        UserMessage(id="u2", role="user", content="newest"),
    ]
    one = (1, 0, 1)
    # The budget reaches the result but not its call: the start moves past both.
    assert replay_start(messages, [one] * 5, budget=(3, 0, 3)) == 3
    # The newest question is kept whatever it costs.
    assert replay_start(messages, [one] * 4 + [(50, 0, 50)], budget=(3, 0, 3)) == 4
    # Any one limit is enough to leave a message out: here, the media.
    assert replay_start(messages, [(1, 9, 1)] + [one] * 4, budget=(9, 5, 9)) == 1
    # Everything fits: nothing is left out.
    assert replay_start(messages, [one] * 5, budget=(5, 0, 5)) == 0


MISSED_QUESTION = "CONTRACT_MISSED_QUESTION_7f3a"


def test_a_live_session_is_reused_rather_than_rebuilt(monkeypatch, tmp_path):
    """Two runs on one healthy session: the second is a turn of the same harness conversation."""
    first = conversation()
    with fresh_bot(monkeypatch, tmp_path) as run:
        run(first)
        body = run(_next_turn(first, _said(run.events[0])))
    turns = [content.get("role") for content in body.get("contents", [])]
    assert turns[-1] == "user" and "model" in turns, (
        "the newest question is its own turn after the model's earlier reply, not a rebuilt history",
        turns,
    )


def test_a_turn_answered_elsewhere_reaches_a_live_session(monkeypatch, tmp_path):
    """Another replica, or this one before a crash it survived, answered a turn this session missed."""
    first = conversation()
    with fresh_bot(monkeypatch, tmp_path) as run:
        run(first)
        following = _next_turn(first, _said(run.events[0]))
        following["messages"][-2:-2] = [
            {"id": "u2b", "role": "user", "content": f"Something else. {MISSED_QUESTION}"},
            {"id": "a2b", "role": "assistant", "content": "Answered by another replica."},
        ]
        body = run(following)
    sent = json.dumps(body)
    assert MISSED_QUESTION in sent, "the turn this session never saw reached the model"
    assert missing_from(body) == []
    for marker in (EARLIER_QUESTION, LATEST_QUESTION, NEXT_QUESTION, MISSED_QUESTION):
        assert sent.count(marker) == 1, (marker, sent)


LOOKUP = {
    "name": "lookup",
    "description": "Look something up.",
    "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
}
TOOL_RESULT = "CONTRACT_TOOL_RESULT_7f3a"
OTHER_REPLICA = "CONTRACT_OTHER_REPLICA_ANSWER_7f3a"


def _calls_lookup() -> dict:
    return _answer({"functionCall": {"name": "lookup", "args": {"q": "x"}}})


def _with_result(run: dict, call_id: str) -> dict:
    """The run the server sends next: the call the Bot made, and the tool's result for it.

    A call made with no text before it is filed under a message named after the call.
    """
    following = json.loads(json.dumps(run))
    following["runId"] = "contract-run-2"
    following["messages"] += [
        {
            "id": call_id,
            "role": "assistant",
            "content": "",
            "toolCalls": [
                {"id": call_id, "type": "function", "function": {"name": "lookup", "arguments": '{"q":"x"}'}}
            ],
        },
        {"id": "t1", "role": "tool", "toolCallId": call_id, "content": TOOL_RESULT},
    ]
    return following


@contextmanager
def _after_a_tool_call(monkeypatch, tmp_path):
    """A Bot that was asked the contract question and answered by calling `lookup`, parked on it."""
    first = conversation()
    first["tools"] = [LOOKUP]
    with fresh_bot(monkeypatch, tmp_path, replies=[_calls_lookup()]) as run:
        run(first)
        call_id = next(e["toolCallId"] for e in run.events[0] if e["type"] == "TOOL_CALL_START")
        yield run, first, call_id


def test_a_tool_result_resumes_the_turn_that_called_for_it(monkeypatch, tmp_path):
    """The client-tool continuation on the replica that made the call: the same harness turn."""
    with _after_a_tool_call(monkeypatch, tmp_path) as (run, first, call_id):
        body = run(_with_result(first, call_id))
    sent = json.dumps(body)
    assert "functionResponse" in sent and TOOL_RESULT in sent, sent
    assert sent.count(EARLIER_QUESTION) == 1 and sent.count(LATEST_QUESTION) == 1, sent
    assert len(run.bodies) == 2, "the turn was resumed, not started again"


def test_a_tool_result_another_replica_answered_is_not_answered_again(monkeypatch, tmp_path):
    """This replica called a tool; another one took the result and answered; the next turn is here.

    The parked session must not take the result out of the thread and answer the old turn a second
    time. It starts again from the thread, which holds the other replica's answer.
    """
    with _after_a_tool_call(monkeypatch, tmp_path) as (run, first, call_id):
        following = _with_result(first, call_id)
        following["messages"] += [
            {"id": "elsewhere", "role": "assistant", "content": f"The answer. {OTHER_REPLICA}"},
            {"id": "u3", "role": "user", "content": f"And after that? {NEXT_QUESTION}"},
        ]
        before = len(run.bodies)
        body = run(following)
        this_turn = run.bodies[before:]
    assert all(OTHER_REPLICA in json.dumps(sent) for sent in this_turn), (
        "the old turn was answered again without the other replica's answer",
        [json.dumps(sent)[-600:] for sent in this_turn],
    )
    sent = json.dumps(body)
    for marker in (EARLIER_QUESTION, LATEST_QUESTION, TOOL_RESULT, OTHER_REPLICA, NEXT_QUESTION):
        assert sent.count(marker) == 1, (marker, sent)


def test_a_thread_without_a_turn_the_session_holds_starts_again(monkeypatch, tmp_path):
    """The session holds an answer the thread does not: it must not carry it into the next turn."""
    first = conversation()
    with fresh_bot(monkeypatch, tmp_path) as run:
        run(first)
        following = json.loads(json.dumps(first))
        following["runId"] = "contract-run-2"
        following["messages"][-1] = {"id": "u2-instead", "role": "user", "content": NEXT_QUESTION}
        body = run(following)
    sent = json.dumps(body)
    assert LATEST_QUESTION not in sent, "the turn the thread no longer has reached the model"
    assert NEXT_QUESTION in sent and EARLIER_QUESTION in sent


def test_a_run_that_arrives_while_another_streams_does_not_end_it(monkeypatch, tmp_path):
    """Two runs on one thread at once, the second needing a rebuild: the first still finishes.

    Closing the session underneath a run that is streaming cancels what that run is waiting on, and
    it ends without its RUN_FINISHED.
    """
    first = conversation()
    with fresh_bot(monkeypatch, tmp_path, slow=NEXT_QUESTION) as run:
        run(first)
        slow_turn = _next_turn(first, _said(run.events[0]))
        diverged = json.loads(json.dumps(slow_turn))
        diverged["runId"] = "contract-run-3"
        diverged["messages"][-2:-2] = [
            {"id": "u2b", "role": "user", "content": f"Something else. {MISSED_QUESTION}"},
            {"id": "a2b", "role": "assistant", "content": "Answered by another replica."},
        ]
        results = {}

        def post(name, body):
            results[name] = run.post(body)

        streaming = threading.Thread(target=post, args=("slow", slow_turn))
        streaming.start()
        time.sleep(0.8)
        post("diverged", diverged)
        streaming.join(timeout=30)
    for name in ("slow", "diverged"):
        assert [e["type"] for e in results[name] if e["type"].startswith("RUN_")] == [
            "RUN_STARTED",
            "RUN_FINISHED",
        ], (name, results[name])
