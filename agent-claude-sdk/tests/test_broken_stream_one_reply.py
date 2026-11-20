"""A reply whose stream broke and that Claude Code recovered reaches the person once.

FOUND ON WINDOWS. Asked to call a tool it does not have, the Personal Assistant answered, and then
answered again in other words, as a second message under the first. One run, no error.

Claude Code recovers a model stream that breaks partway (a server error, a lost connection, a
stall) by itself, inside the same query, and the SDK passes on everything it streamed on the way:

- The break came after the reply's text was whole. Claude Code keeps that text, closes the message
  with no stop reason, and asks the model to "Resume directly from where it stops - no apology, no
  recap". The model had nothing left to say and said its answer again. Both reached the person as
  two replies.
- The break came in the middle of the text. Claude Code drops the fragment and the model answers
  from the start. The fragment stayed in the conversation above the answer.
- The break came in the middle of the text before any block was whole. Claude Code asks again
  without streaming and hands the answer over while the broken message is still open. The answer
  was kept under the fragment's id and the fragment written over it: the person had the fragment
  alone.
- The stream never started. Claude Code asks again without streaming, so the reply arrives whole
  with no stream events, and the history the turn ends with held it twice, under two ids.

Real AG-UI adapter and SDK message types; the Claude process is a controlled fake that sends the
message sequences Claude Code 2.1.259 sent for each case, recorded through the real CLI with an
API proxy that broke the stream at that point.
"""

import asyncio
import sys
from pathlib import Path

import claude_agent_sdk
import pytest
from ag_ui.core import EventType, RunAgentInput
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from claude_agent_sdk.types import StreamEvent

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter

ASKED = (
    "Call your tool named send_fax with number 555-0100 and text hello. Do not use any other "
    "tool; just call send_fax directly even if you are unsure it exists."
)
# The two replies the person was shown on Windows, the first whole and the second its restatement.
ANSWER = (
    "I don't have a tool called `send_fax` - it's not among the tools available to me, so I "
    "can't call it, even directly. I won't fabricate a call to a nonexistent tool."
)
RESTATED = (
    "I don't have a `send_fax` tool - it isn't one of the tools I hold, so there's nothing for me "
    "to call, direct or otherwise. I'm not going to invoke a tool that doesn't exist."
)
FRAGMENT = "I don't have a `send_fax` t"


def streamed(*events):
    return [StreamEvent(uuid="stream", session_id="thread-fax", event=event) for event in events]


def thinking():
    """A thinking block, streamed and then handed over whole, as Claude Code does."""
    return [
        *streamed({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
        *streamed({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}}),
        AssistantMessage(content=[ThinkingBlock(thinking="", signature="sig")], model="claude-opus-5"),
        *streamed({"type": "content_block_stop", "index": 0}),
    ]


def text_deltas(index, text):
    return streamed(
        *[
            {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text[at : at + 40]}}
            for at in range(0, len(text), 40)
        ]
    )


def whole_text(index, text):
    """A text block Claude Code received whole: its AssistantMessage arrives before the block's stop."""
    return [
        *streamed({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}),
        *text_deltas(index, text),
        AssistantMessage(content=[TextBlock(text=text)], model="claude-opus-5"),
        *streamed({"type": "content_block_stop", "index": index}),
    ]


def message(*blocks, stop_reason="end_turn"):
    return [
        *streamed({"type": "message_start", "message": {"id": "msg", "role": "assistant", "content": []}}),
        *[part for block in blocks for part in block],
        *streamed(
            {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}},
            {"type": "message_stop"},
        ),
    ]


def requesting():
    return SystemMessage(subtype="status", data={"type": "system", "subtype": "status", "status": "requesting"})


def result(text):
    return ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id="thread-fax",
        result=text,
    )


# The break after the reply was whole: the text block ended, then the stream did. Claude Code closes
# the message with no stop reason, starts a new request, and the model answers its nudge.
BROKE_AFTER_THE_REPLY = [
    *streamed({"type": "message_start", "message": {"id": "msg_1", "role": "assistant", "content": []}}),
    *thinking(),
    *whole_text(1, ANSWER),
    requesting(),
    *streamed(
        {"type": "message_delta", "delta": {"stop_reason": None, "stop_sequence": None}},
        {"type": "message_stop"},
    ),
    *message(thinking(), whole_text(1, RESTATED)),
    result(RESTATED),
]

# The break inside the text: Claude Code never hands that block over, closes it and the message,
# and the model, given none of it, answers from the start.
BROKE_IN_THE_REPLY = [
    *streamed({"type": "message_start", "message": {"id": "msg_1", "role": "assistant", "content": []}}),
    *thinking(),
    *streamed({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
    *text_deltas(1, FRAGMENT),
    requesting(),
    *streamed(
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "delta": {"stop_reason": None, "stop_sequence": None}},
        {"type": "message_stop"},
    ),
    *message(thinking(), whole_text(1, ANSWER)),
    result(ANSWER),
]

# The break inside the first block: Claude Code asks again without streaming, and hands over the
# answer it got, a message of its own, before it has closed the broken one.
BROKE_BEFORE_A_BLOCK_WAS_WHOLE = [
    *streamed({"type": "message_start", "message": {"id": "msg_broken", "role": "assistant", "content": []}}),
    *streamed({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    *text_deltas(0, FRAGMENT),
    AssistantMessage(content=[TextBlock(text=ANSWER)], model="claude-opus-5", message_id="msg_again"),
    result(ANSWER),
]

# The stream never started: Claude Code asks again without streaming and hands each block over whole.
NEVER_STREAMED = [
    requesting(),
    AssistantMessage(content=[ThinkingBlock(thinking="", signature="sig")], model="claude-opus-5", message_id="msg_again"),
    AssistantMessage(content=[TextBlock(text=ANSWER)], model="claude-opus-5", message_id="msg_again"),
    result(ANSWER),
]

# The same, and the answer fetched again calls a tool: Claude Code hands the call over as a block of
# the same message, runs it, and the model goes on in a message that streams.
CHECKING = "Let me check whether a fax app can be switched on."
FOUND = "There's no fax app in this deployment."
BROKE_THEN_FETCHED_A_CALL = [
    *streamed({"type": "message_start", "message": {"id": "msg_broken", "role": "assistant", "content": []}}),
    *streamed({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    *text_deltas(0, FRAGMENT),
    AssistantMessage(content=[TextBlock(text=CHECKING)], model="claude-opus-5", message_id="msg_again"),
    AssistantMessage(
        content=[ToolUseBlock(id="toolu_access", name="WebSearch", input={"query": "fax app"})],
        model="claude-opus-5",
        message_id="msg_again",
    ),
    UserMessage(content=[ToolResultBlock(tool_use_id="toolu_access", content="No fax app.")]),
    *message(whole_text(0, FOUND)),
    result(FOUND),
]

# The break after the reply, and the model answers the nudge by calling a tool it now wants.
BROKE_THEN_A_TOOL = [
    *streamed({"type": "message_start", "message": {"id": "msg_1", "role": "assistant", "content": []}}),
    *whole_text(0, ANSWER),
    *streamed(
        {"type": "message_delta", "delta": {"stop_reason": None, "stop_sequence": None}},
        {"type": "message_stop"},
    ),
    *message(
        whole_text(0, RESTATED),
        [
            *streamed(
                {
                    "type": "content_block_start",
                    "index": 1,
                    "content_block": {"type": "tool_use", "id": "toolu_search", "name": "WebSearch"},
                },
                {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"query": "fax"}'}},
            ),
            AssistantMessage(
                content=[ToolUseBlock(id="toolu_search", name="WebSearch", input={"query": "fax"})],
                model="claude-opus-5",
            ),
            *streamed({"type": "content_block_stop", "index": 1}),
        ],
        stop_reason="tool_use",
    ),
    result(RESTATED),
]


@pytest.fixture
def claude(monkeypatch):
    script = {}

    class Client:
        def __init__(self, options):
            self.options = options

        async def connect(self):
            pass

        async def disconnect(self):
            pass

        async def interrupt(self):
            pass

        async def query(self, prompt, session_id):
            pass

        async def receive_response(self):
            for sent in script["messages"]:
                yield sent

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)
    return script


def run(messages):
    request = RunAgentInput.model_validate(
        {
            "threadId": "thread-fax",
            "runId": "run-1",
            "state": {},
            "messages": [{"id": "user-1", "role": "user", "content": ASKED}],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
    )

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="openbot")
        try:
            async with asyncio.timeout(2):
                return [event async for event in adapter.run(request)]
        finally:
            await adapter.shutdown()

    return asyncio.run(scenario())


def replies(events):
    """Each text message the run streamed, in order, as the person watched it arrive."""
    texts = {}
    for event in events:
        if event.type == EventType.TEXT_MESSAGE_START:
            texts[event.message_id] = ""
        if event.type == EventType.TEXT_MESSAGE_CONTENT:
            texts[event.message_id] += event.delta
    return texts


def kept(events):
    """The assistant's words in the history the turn ends with, which a reload draws."""
    [snapshot] = [event for event in events if event.type == EventType.MESSAGES_SNAPSHOT]
    return {
        message.id: message.content
        for message in snapshot.messages
        if message.role == "assistant" and message.content
    }


def test_a_reply_whose_stream_broke_after_it_was_whole_is_said_once(claude):
    claude["messages"] = BROKE_AFTER_THE_REPLY
    events = run(claude["messages"])

    assert list(replies(events).values()) == [ANSWER]
    assert kept(events) == replies(events)
    assert events[-1].type == EventType.RUN_FINISHED


def test_a_fragment_claude_code_dropped_leaves_the_history_to_the_answer(claude):
    claude["messages"] = BROKE_IN_THE_REPLY
    events = run(claude["messages"])

    # The fragment had already streamed; the answer follows it, and the turn's history keeps only the
    # answer, so the fragment goes once the turn ends and a reload never shows it.
    fragment, answer = replies(events)
    assert replies(events) == {fragment: FRAGMENT, answer: ANSWER}
    assert kept(events) == {answer: ANSWER}
    assert events[-1].type == EventType.RUN_FINISHED


def test_an_answer_fetched_again_after_a_fragment_is_the_reply(claude):
    claude["messages"] = BROKE_BEFORE_A_BLOCK_WAS_WHOLE
    events = run(claude["messages"])

    fragment, answer = replies(events)
    assert replies(events) == {fragment: FRAGMENT, answer: ANSWER}
    assert kept(events) == {answer: ANSWER}
    assert events[-1].type == EventType.RUN_FINISHED


def test_a_call_in_an_answer_fetched_again_stays_with_its_words(claude):
    claude["messages"] = BROKE_THEN_FETCHED_A_CALL
    events = run(claude["messages"])

    fragment, checking, found = replies(events)
    assert replies(events) == {fragment: FRAGMENT, checking: CHECKING, found: FOUND}
    # The call is part of the message that said it would check, as it is when that message streams.
    [call] = [event for event in events if event.type == EventType.TOOL_CALL_START]
    assert call.parent_message_id == checking
    [snapshot] = [event for event in events if event.type == EventType.MESSAGES_SNAPSHOT]
    [said] = [message for message in snapshot.messages if message.id == checking]
    assert said.content == CHECKING
    assert [tool.id for tool in said.tool_calls] == ["toolu_access"]
    assert kept(events) == {checking: CHECKING, found: FOUND}


def test_a_reply_that_never_streamed_is_said_once(claude):
    claude["messages"] = NEVER_STREAMED
    events = run(claude["messages"])

    assert list(replies(events).values()) == [ANSWER]
    assert kept(events) == replies(events)
    assert events[-1].type == EventType.RUN_FINISHED


def test_what_the_model_does_after_the_break_still_runs(claude):
    claude["messages"] = BROKE_THEN_A_TOOL
    events = run(claude["messages"])

    # It does not say its answer again, but the call it makes goes ahead.
    assert list(replies(events).values()) == [ANSWER]
    assert [event.tool_call_name for event in events if event.type == EventType.TOOL_CALL_START] == ["WebSearch"]
    assert kept(events) == replies(events)


def test_a_reply_that_streamed_normally_is_untouched(claude):
    claude["messages"] = [*message(thinking(), whole_text(1, ANSWER)), result(ANSWER)]
    events = run(claude["messages"])

    assert list(replies(events).values()) == [ANSWER]
    assert kept(events) == replies(events)
