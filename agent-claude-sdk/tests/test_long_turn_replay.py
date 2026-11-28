"""A turn hundreds of steps long still replays inside the budget.

A person's turn has no step ceiling: the server answers each tool call and sends the whole thread
back, and a long task is one turn of hundreds of steps. The replay used to cut only earlier turns'
results and keep everything from the person's latest message on, so such a turn replayed whole and
was refused as too long. Now the turn's own older results are cut, then cleared, keeping its newest
results whole, and only then are its oldest steps left out.

Real replay functions on real AG-UI messages, with results the size of an app's listing.
"""

import json
import sys
from pathlib import Path

from ag_ui.core import RunAgentInput

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.replay import REPLAY_BUDGET_TOKENS, conversation_content, estimated_tokens

# The newest results a replay keeps whole, as OpenBot's other engines do.
KEEP_WHOLE_RESULTS = 10
STEPS = 100
# Three reads at once, as a Bot batches them: 300 results in all.
BATCH = 3
FIRST_REQUEST = "FIRST_REQUEST: go through every open ticket and file a summary for each."
LATEST_REQUEST = "LATEST_REQUEST: carry on, and do the billing ones too."


def result(number, size):
    """One read's result: a page of records, marked at both ends so a cut shows."""
    rows = [
        {"id": f"ticket-{number}-{row}", "subject": f"Ticket {row}", "body": "x" * 300}
        for row in range(size // 360)
    ]
    return f"RESULT_{number:03d}_HEAD " + json.dumps(rows) + f" RESULT_{number:03d}_TAIL"


def long_turn(result_size):
    messages = [
        {"id": "standing-role:bot_1", "role": "system", "content": "You are a Bot."},
        {"id": "first", "role": "user", "content": FIRST_REQUEST},
        {"id": "first-answer", "role": "assistant", "content": "Started on the tickets."},
        {"id": "latest", "role": "user", "content": LATEST_REQUEST},
    ]
    number = 0
    for step in range(STEPS):
        calls = []
        for _ in range(BATCH):
            calls.append(
                {
                    "id": f"call-{number:03d}",
                    "type": "function",
                    "function": {"name": "tickets_read", "arguments": json.dumps({"n": number})},
                }
            )
            number += 1
        messages.append({"id": f"step-{step}", "role": "assistant", "content": "", "toolCalls": calls})
        for call in calls:
            messages.append(
                {
                    "id": f"tool-{call['id']}",
                    "role": "tool",
                    "toolCallId": call["id"],
                    "content": result(int(call["id"][5:]), result_size),
                }
            )
    return RunAgentInput.model_validate(
        {
            "threadId": "thread-long",
            "runId": "run-long",
            "state": {},
            "messages": messages,
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
    ).messages


def replayed(content):
    """The messages a replay carries, read back from its labelled entries."""
    found = []
    for block in content:
        if block["type"] != "text":
            continue
        try:
            entry = json.loads(block["text"])
        except ValueError:
            continue
        if isinstance(entry, dict) and "role" in entry:
            found.append(entry)
    return found


def assert_paired(entries):
    calls = {call["id"] for entry in entries for call in entry.get("toolCalls", [])}
    results = {entry["toolCallId"] for entry in entries if entry["role"] == "tool"}
    assert calls == results, "every replayed call has its result, and every result its call"


def test_a_long_current_turn_fits_the_budget_and_keeps_its_newest_results_whole():
    messages = long_turn(6_000)
    total = STEPS * BATCH
    # Over the budget many times, or the test would prove nothing.
    assert sum(len(message.content or "") for message in messages) > 10 * REPLAY_BUDGET_TOKENS

    content = conversation_content(messages)
    text = "\n".join(block["text"] for block in content if block["type"] == "text")

    assert estimated_tokens(content) <= REPLAY_BUDGET_TOKENS
    assert FIRST_REQUEST in text, "the person's first message is kept"
    assert LATEST_REQUEST in text, "and their latest"
    for number in range(total - KEEP_WHOLE_RESULTS, total):
        assert f"RESULT_{number:03d}_HEAD" in text
        assert f"RESULT_{number:03d}_TAIL" in text, f"result {number} is one of the newest, whole"
    assert "RESULT_000_TAIL" not in text, "the oldest results are not"
    # Older results are cleared before any step is left out, each naming its call.
    assert 'was cleared to make room in the conversation' in text
    assert "recall_earlier_results" not in text, "no recall is offered, so none is named"
    assert_paired(replayed(content))


def test_a_cleared_result_names_recall_when_the_run_offers_it():
    content = conversation_content(long_turn(6_000), recall=True)
    cleared = [
        entry
        for entry in replayed(content)
        if entry["role"] == "tool" and "was cleared to make room" in entry["content"]
    ]
    assert cleared
    for entry in cleared:
        assert entry["content"] == (
            "[This result was cleared to make room in the conversation. Call "
            f'recall_earlier_results with call_id "{entry["toolCallId"]}" to read it again.]'
        )


def test_a_long_turn_of_large_results_fits_on_the_too_long_retry():
    """Ten results of 20 KB are over the budget on their own, so the first replay keeps them whole
    and over it; the retry after the model refuses it as too long cuts them, and fits."""
    messages = long_turn(20_000)
    total = STEPS * BATCH

    first = conversation_content(messages)
    first_text = "\n".join(block["text"] for block in first if block["type"] == "text")
    for number in range(total - KEEP_WHOLE_RESULTS, total):
        assert f"RESULT_{number:03d}_TAIL" in first_text
    assert LATEST_REQUEST in first_text
    assert_paired(replayed(first))

    retry = conversation_content(messages, fit_results=True)
    text = "\n".join(block["text"] for block in retry if block["type"] == "text")
    assert estimated_tokens(retry) <= REPLAY_BUDGET_TOKENS
    assert FIRST_REQUEST in text
    assert LATEST_REQUEST in text
    assert f"RESULT_{total - 1:03d}_HEAD" in text, "the newest result keeps its start"
    # No recall offered: a cleared result says to call the tool again instead.
    assert "recall_earlier_results" not in text
    assert_paired(replayed(retry))
