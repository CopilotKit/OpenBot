"""The first question of a conversation is answered, however large what a tool brought back.

FOUND ON A MAC (OpenBot 1.0.1). A person asked the Personal Assistant, on this harness and a Claude
plan, "what was added to the just updated version of openbot?". It searched the web and Notion, and
the turn ended at once on "Claude turned down the request because this conversation is too long for
the model". It was the first message of a new conversation.

The Claude Code this harness ships (2.1.259) predates the Claude 5.5 models it is run on, and holds a
session on a model ID it does not know to an assumed 200K window. The 5.5 models have 1M. And the
harness left Claude Code's tool search out, so every app tool a Bot holds (up to 128 in a run) went
with every request in full. Reproduced live on the API: 128 real app tools and a 170 KB standing
role came to 182,173 tokens on the first request, and after one web page cut to the server's 20,000
characters Claude Code refused the next request itself, never sending it: "Prompt is too long". Its
own compaction could not recover, because the replay is one first prompt with no earlier exchange to
summarise. A result whose query had ended was replayed whole, too, however large.

These run the real Claude Code this harness ships, through the harness's own routes, against a local
stand-in for the Messages API. It refuses a request over the model's window with the error the API
sends, status, header and body as measured on the real API, and reports the input it was sent as
usage, as the API does. Tokens are counted at four characters each: the content here is plain
English, which the real tokenizer counts at more characters a token than that, so a request it
refuses the API would refuse too.
"""

import asyncio
import importlib
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "valid-test-token"
QUESTION = "what was added to the just updated version of openbot?"
ANSWER = "Version 1.0.1 adds signed updates and faster setup."
# "prompt is too long: 1799056 tokens > 1000000 maximum", measured on claude-sonnet-5-5,
# claude-opus-5-5 and claude-haiku-5-5.
WINDOW_5_5 = 1_000_000
CHARS_PER_TOKEN = 4


def tokens(body):
    return len(json.dumps(body)) // CHARS_PER_TOKEN


def _events(lines):
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in lines)


def _reply(model, used, blocks):
    """One streamed Messages API reply, as the API sends it."""
    events = [
        {
            "type": "message_start",
            "message": {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": used, "output_tokens": 1},
            },
        }
    ]
    stop = "end_turn"
    for index, block in enumerate(blocks):
        if block["type"] == "text":
            start = {"type": "text", "text": ""}
            delta = {"type": "text_delta", "text": block["text"]}
        else:
            stop = "tool_use"
            start = {"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}}
            delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
        events += [
            {"type": "content_block_start", "index": index, "content_block": start},
            {"type": "content_block_delta", "index": index, "delta": delta},
            {"type": "content_block_stop", "index": index},
        ]
    return events + [
        {
            "type": "message_delta",
            "delta": {"stop_reason": stop, "stop_sequence": None},
            "usage": {"output_tokens": 12},
        },
        {"type": "message_stop"},
    ]


@pytest.fixture
def messages_api():
    """A local Messages API with a context window, keeping every request it answered.

    It calls the Bot's search tool when it is offered one and has no result yet, and answers once
    it has.
    """
    asked = []
    state = {"window": WINDOW_5_5, "refused": 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status, payload, kind, headers=()):
            self.send_response(status)
            self.send_header("content-type", kind)
            for name, value in headers:
                self.send_header(name, value)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            if not self.path.startswith("/v1/messages"):
                self._send(404, b"{}", "application/json")
                return
            used = tokens(body)
            if "count_tokens" in self.path:
                self._send(200, json.dumps({"input_tokens": used}).encode(), "application/json")
                return
            if used > state["window"]:
                state["refused"] += 1
                error = {
                    "type": "error",
                    "error": {
                        "type": "invalid_request_error",
                        "message": f"prompt is too long: {used} tokens > {state['window']} maximum",
                    },
                    "request_id": "req_test",
                }
                self._send(400, json.dumps(error).encode(), "application/json", [("x-should-retry", "false")])
                return
            asked.append(body)
            sent = json.dumps(body["messages"])
            names = [tool["name"] for tool in body.get("tools") or [] if not tool.get("defer_loading")]
            fetch = next((name for name in names if name.endswith("web_fetch")), None)
            waiting = re.search(r"mcp__ag_ui__[\w-]*web_fetch", sent)
            # A replay carries the result as labelled text, a running query as a tool_result.
            if "release notes:" in sent:
                blocks = [{"type": "text", "text": ANSWER}]
            elif "toolu_fetch" in sent:
                # It called the tool once already; it does not call it again.
                blocks = [{"type": "text", "text": ANSWER}]
            elif fetch or (waiting and "tool_reference" in sent):
                blocks = [
                    {"type": "text", "text": "I'll read the release notes."},
                    {"type": "tool_use", "id": "toolu_fetch", "name": fetch or waiting.group(0), "input": {"url": "https://open.bot/changelog"}},
                ]
            elif waiting and "ToolSearch" in names and "toolu_search" not in sent:
                # Its definition waits behind the tool search: look it up first, as Claude does.
                blocks = [
                    {"type": "tool_use", "id": "toolu_search", "name": "ToolSearch", "input": {"query": f"select:{waiting.group(0)}", "max_results": 5}},
                ]
            else:
                blocks = [{"type": "text", "text": ANSWER}]
            model = body.get("model", "claude-test")
            if body.get("stream"):
                self._send(200, _events(_reply(model, used, blocks)).encode(), "text/event-stream")
            else:
                message = {**_reply(model, used, blocks)[0]["message"], "content": blocks, "stop_reason": "end_turn"}
                self._send(200, json.dumps(message).encode(), "application/json")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", asked, state
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def app(monkeypatch, tmp_path, messages_api):
    url, _, _ = messages_api
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", url)
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.setenv("CLAUDE_CODE_MAX_RETRIES", "0")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    from src import main

    return importlib.reload(main).app


def app_tools(count):
    """A Bot's app tools, each the size of a Composio action's schema (about 2,400 characters)."""
    field = {
        "type": "string",
        "description": "Filter the results by this value. " + "Leave it out to include every item. " * 8,
    }
    return [
        {
            "name": f"mcp__composio-slack__SLACK_ACTION_{index}",
            "description": "Runs one Slack action for the person and returns what Slack answered. " * 6,
            "parameters": {
                "type": "object",
                "properties": {f"field_{n}": field for n in range(4)},
            },
        }
        for index in range(count)
    ]


FETCH = {
    "name": "mcp__parallel__web_fetch",
    "description": "Read web pages by URL.",
    "parameters": {"type": "object", "properties": {"url": {"type": "string"}}},
}


def page(chars):
    return ("OpenBot 1.0.1 release notes: signed updates, faster setup. " * (chars // 60 + 1))[:chars]


def run_body(thread, run, messages, tools, model, standing_role=None):
    return {
        "threadId": thread,
        "runId": run,
        "state": {},
        "messages": [
            *([{"id": "standing-role:pa", "role": "system", "content": standing_role}] if standing_role else []),
            *messages,
        ],
        "tools": tools,
        "context": [],
        "forwardedProps": {"openbotModel": {"model": model}},
    }


def _runs(app, path, *steps):
    """Runs sent one after another to one harness process, as the server sends a turn's runs.

    In one event loop, so the query a run leaves waiting on its tool call is still there for the
    run that brings the result. Each step is a run's body, or a function of the events of the runs
    before it that returns one.
    """

    async def send():
        done = []
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://harness", timeout=300
        ) as client:
            for step in steps:
                response = await client.post(
                    path,
                    headers={"x-openbot-agent-token": TOKEN, "accept": "text/event-stream"},
                    json=step(done) if callable(step) else step,
                )
                assert response.status_code == 200
                done.append(
                    [
                        json.loads(line.removeprefix("data: "))
                        for line in response.text.splitlines()
                        if line.startswith("data: ")
                    ]
                )
        return done

    return asyncio.run(send())


def _run(app, path, body):
    return _runs(app, path, body)[0]


def errors(events):
    return [event["message"] for event in events if event["type"] == "RUN_ERROR"]


def said(events):
    return "".join(event["delta"] for event in events if event["type"] == "TEXT_MESSAGE_CONTENT")


def question():
    return {"id": "user-1", "role": "user", "content": QUESTION}


def call_and_result(call_id, content):
    return [
        {
            "id": "assistant-1",
            "role": "assistant",
            "content": "I'll read the release notes.",
            "toolCalls": [
                {"id": call_id, "type": "function", "function": {"name": FETCH["name"], "arguments": "{}"}}
            ],
        },
        {"id": "result-1", "role": "tool", "toolCallId": call_id, "content": content},
    ]


def first_question_then_result(app, tools, role, result, model="claude-sonnet-5-5", before_result=None):
    """One question, the Bot's call, then the run the browser sends with its result."""

    def with_result(done):
        assert errors(done[0]) == []
        # The client tool's call: a `ToolSearch` before it is Claude Code's own, answered in the run.
        call = next(
            event
            for event in done[0]
            if event["type"] == "TOOL_CALL_START" and event["toolCallName"].endswith("web_fetch")
        )
        if before_result:
            before_result()
        return run_body(
            "thread-pa",
            "run-2",
            [question(), *call_and_result(call["toolCallId"], result)],
            tools,
            model,
            role,
        )

    first = run_body("thread-pa", "run-1", [question()], tools, model, role)
    return _runs(app, "/", first, with_result)[1]


def test_a_bot_holding_many_apps_is_sent_their_tools_when_it_looks_for_them(app, messages_api, monkeypatch):
    """The bulk of the reported request: every app tool's definition, on every request.

    Measured on the real API with the adapter's own options: a Bot sent 128 real Composio tools
    (Slack, Gmail, Calendar, HubSpot, Routines, Parallel) and a 50 KB standing role cost 133,798
    input tokens before the person's question was answered, and 27,932 with Claude Code's tool
    search on. Claude Code loads every MCP tool upfront when `ToolSearch` is left out of `--tools`
    (code.claude.com/docs/en/mcp, "Configure tool search"), and the full harness left it out.
    """
    _, asked, _ = messages_api
    # On by default against Anthropic's API; this Claude Code turns it off for any other base URL.
    monkeypatch.setenv("ENABLE_TOOL_SEARCH", "true")
    tools = [FETCH, *app_tools(127)]
    second = first_question_then_result(app, tools, None, page(20_000))
    assert errors(second) == []
    assert said(second) == ANSWER
    first_request = next(body for body in asked if body.get("tools"))
    sent = [tool["name"] for tool in first_request["tools"]]
    assert "ToolSearch" in sent
    assert not [name for name in sent if "__composio-slack__" in name or name.endswith("web_fetch")], (
        "every app tool's definition went with the first request"
    )
    # The definitions are a small part of what was sent.
    assert tokens(first_request) < len(json.dumps(tools)) // CHARS_PER_TOKEN // 2
    # The Bot looked its tool up, called it, and was answered with the result.
    assert any("tool_reference" in json.dumps(body["messages"]) for body in asked)
    assert any("release notes:" in json.dumps(body["messages"]) for body in asked)


def test_the_first_question_on_a_claude_5_5_model_is_not_held_to_200k(app, messages_api, monkeypatch):
    """The shape that was reported: one question, a large prompt, one result, a 5.5 model.

    The model's window is 1M. The Claude Code this harness ships does not know the 5.5 models and
    held the session to 200K: past it, the turn ended on "Prompt is too long" and the request was
    never sent. Tool search is off here so the prompt is as large as it was.
    """
    _, asked, state = messages_api
    monkeypatch.setenv("ENABLE_TOOL_SEARCH", "false")
    role = "You are a personal assistant for one person.\n\n" + page(790_000)
    second = first_question_then_result(app, [FETCH], role, page(20_000))
    assert errors(second) == [], "the turn ended on 'Prompt is too long' without asking the model"
    assert said(second) == ANSWER
    with_result = [
        body
        for body in asked
        if "tool_result" in json.dumps(body["messages"])
        and "release notes:" in json.dumps(body["messages"])
    ]
    assert with_result, "the model was asked with the result, not a summary of it"
    # Over 200K with the result in, and far under the model's 1M.
    assert 200_000 < tokens(with_result[0]) < WINDOW_5_5 // 4
    assert state["refused"] == 0


@pytest.mark.parametrize("path", ["/model", "/"])
def test_a_result_larger_than_the_window_is_cut_and_the_turn_answered(app, messages_api, path):
    """A web page larger than the model's window, in a fresh conversation.

    `/model`: a step of a built-in Bot on a Claude plan, answered from a fresh query that replays the
    thread with this step's result in it (`run_replayed_query`). `/`: a Claude Agent SDK Bot, or a
    subagent of one (the same Bot again, at this endpoint), whose result arrived after its query
    ended, which the full harness answers the same way. The replay sent the result whole.
    """
    _, asked, state = messages_api
    huge = page(WINDOW_5_5 * CHARS_PER_TOKEN + 400_000)
    body = run_body("a" * 64, "run-step", [question(), *call_and_result("call-fetch", huge)], [FETCH], "claude-sonnet-5-5")
    if path == "/model":
        body["forwardedProps"] = {
            "openbotModelOnly": True,
            "openbotBotId": "personal-assistant",
            "openbotModel": {"model": "claude-sonnet-5-5"},
        }
    events = _run(app, path, body)

    assert errors(events) == [], "the step was refused as too long"
    assert said(events) == ANSWER
    sent = json.dumps(asked[-1]["messages"])
    assert "OpenBot 1.0.1 release notes" in sent, "the head of the result reaches the model"
    assert "more characters of this result were left out to fit the context window" in sent
    assert "call the tool again asking for less" in sent
    assert state["refused"] == 0


def test_a_turn_still_over_the_window_is_answered_from_the_thread_fitted(app, messages_api):
    """Over the window even with each result at its inline limit: the turn is replayed once, every
    result fitted to the replay's budget, and answered. Refused again, the person is told."""
    _, asked, state = messages_api
    tools = [FETCH, *app_tools(10)]

    def narrow_window():
        # A window the request with the whole result is over, and the thread with it fitted is under.
        state["window"] = tokens(asked[-1]) + 20_000

    second = first_question_then_result(app, tools, None, page(99_000), before_result=narrow_window)

    assert state["refused"] >= 1, "the request with the whole result was over the window"
    assert errors(second) == []
    assert said(second) == ANSWER
    sent = json.dumps(asked[-1]["messages"])
    assert "more characters of this result were left out to fit the context window" in sent
    # The person's question is still what the Bot answers.
    assert QUESTION in sent


def test_a_turn_over_the_window_however_it_is_fitted_says_so(app, messages_api):
    """The genuine case keeps its words: the server turns this into "too long for the model"."""
    _, _, state = messages_api
    state["window"] = 100
    events = _run(app, "/", run_body("thread-over", "run-1", [question()], [FETCH], "claude-sonnet-5-5"))
    assert len(errors(events)) == 1
    assert "prompt is too long" in errors(events)[0].lower()
    assert [event["code"] for event in events if event["type"] == "RUN_ERROR"] == ["OPENBOT_MODEL_REFUSED"]
