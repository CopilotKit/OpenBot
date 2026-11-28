"""Gemini's thought signature on a tool call survives every way a turn goes on.

Gemini 3 gives the first function call of each step a thought signature, and refuses the next
request when the first call of any step in the current turn (everything after the latest user
message that has words, not a function response) comes back without the signature it issued:
400, "Function call is missing a thought_signature in functionCall parts". Earlier turns are not
checked. Natively the signature is the part's `thoughtSignature`; on Google's OpenAI-compatible
endpoint it is `tool_calls[i].extra_content.google.thought_signature`.

A turn goes on two ways here:
- A call the caller owns (a computer or UI tool) ends the run. The next run rebuilds the turn from
  the thread the server sends, so the signature has to leave on the call, as AG-UI carries a
  provider's opaque artefact (REASONING_ENCRYPTED_VALUE with subtype "tool-call", and
  `encryptedValue` on the call in the snapshot), and come back from the thread onto the call.
- A deployment tool is answered inside the run, and the next step is sent the call as the model
  client kept it.

The fake Gemini below keeps Google's rule exactly: it accepts the signature it issued and Google's
documented dummy values, refuses a missing or different one with Google's own error, and checks
only the current turn. Every check goes through the production AG-UI endpoint.
"""

import base64
import json
import sys
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from test_model_choice import environment, finished, run, run_body  # noqa: F401
from test_provider_boundaries import _install_loopback_socket_guard

MODEL = "gemini-3.6-flash"
TOOL = "show_card"
# Google's documented values for a call the API did not generate, which skip the check.
DUMMY_SIGNATURES = {"skip_thought_signature_validator", "context_engineering_is_the_way_to_go"}
MISSING = (
    "Function call is missing a thought_signature in functionCall parts. This is required for "
    "tools to work correctly, and missing thought_signature may lead to degraded model "
    "performance. Additional data, function call `default_api:{name}` , position {position}. "
    "Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details."
)
NOT_VALID = "Unable to submit request because Thought signature is not valid.. Learn more: https://ai.google.dev/gemini-api/docs/thought-signatures"


class FakeGemini:
    """Gemini, natively and at its OpenAI-compatible endpoint, with its thought-signature rule.

    Every step with no function response pending calls `show_card` once, with arguments unique to
    that step, and issues a signature for it. A step after a function response answers in words.
    """

    def __init__(self):
        self.lock = Lock()
        self.issued = {}  # (name, arguments) -> the signature issued with that call
        self.returned = []  # every signature a request carried on a current-turn step's first call
        self.refusals = []
        self.requests = 0
        self.steps_with_calls = 1

    # -- the rule ---------------------------------------------------------------------------------

    def check(self, steps):
        """`steps`: the current turn's model steps, each a list of (name, arguments, signature)."""
        for position, calls in steps:
            if not calls:
                continue
            name, arguments, signature = calls[0]
            self.returned.append(signature)
            if signature in DUMMY_SIGNATURES:
                continue
            if not signature:
                return MISSING.format(name=name, position=position)
            if signature != self.issued.get((name, arguments)):
                return NOT_VALID
        return None

    def issue(self):
        with self.lock:
            step = len(self.issued) + 1
            arguments = json.dumps({"title": f"card {step}"}, sort_keys=True)
            signature = base64.b64encode(f"gemini-signature-{step}".encode()).decode()
            self.issued[(TOOL, arguments)] = signature
            return arguments, signature

    # -- native: generateContent / streamGenerateContent ------------------------------------------

    def native(self, body):
        contents = body.get("contents", [])
        start = 0
        for index in range(len(contents) - 1, -1, -1):
            parts = contents[index].get("parts") or []
            if contents[index].get("role") == "user" and any(
                "text" in part for part in parts
            ) and not any("functionResponse" in part for part in parts):
                start = index + 1
                break
        steps = []
        for index in range(start, len(contents)):
            if contents[index].get("role") != "model":
                continue
            calls = [
                (
                    part["functionCall"]["name"],
                    json.dumps(part["functionCall"].get("args") or {}, sort_keys=True),
                    part.get("thoughtSignature"),
                )
                for part in contents[index].get("parts") or []
                if "functionCall" in part
            ]
            steps.append((index + 1, calls))
        refusal = self.check(steps)
        if refusal:
            return 400, {"error": {"code": 400, "message": refusal, "status": "INVALID_ARGUMENT"}}
        last = (contents[-1].get("parts") or []) if contents else []
        if any("functionResponse" in part for part in last) or not self.calls_left(contents):
            parts = [{"text": "Done."}]
        else:
            arguments, signature = self.issue()
            parts = [
                {
                    "functionCall": {"name": TOOL, "args": json.loads(arguments)},
                    "thoughtSignature": signature,
                }
            ]
        return 200, {
            "candidates": [
                {"content": {"role": "model", "parts": parts}, "finishReason": "STOP", "index": 0}
            ],
            "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
            "modelVersion": MODEL,
        }

    def calls_left(self, contents):
        made = sum(
            1
            for content in contents
            if content.get("role") == "model"
            and any("functionCall" in part for part in content.get("parts") or [])
        )
        return made < self.steps_with_calls

    # -- OpenAI-compatible: /v1beta/openai/chat/completions --------------------------------------

    def compatible(self, body):
        messages = body.get("messages", [])
        start = 0
        for index in range(len(messages) - 1, -1, -1):
            if messages[index].get("role") == "user":
                start = index + 1
                break
        steps = []
        for index in range(start, len(messages)):
            message = messages[index]
            if message.get("role") != "assistant":
                continue
            calls = [
                (
                    call["function"]["name"],
                    json.dumps(json.loads(call["function"].get("arguments") or "{}"), sort_keys=True),
                    ((call.get("extra_content") or {}).get("google") or {}).get("thought_signature"),
                )
                for call in message.get("tool_calls") or []
            ]
            steps.append((index, calls))
        refusal = self.check(steps)
        if refusal:
            # Google's OpenAI-compatible endpoint answers a refusal in its own error shape.
            return 400, [{"error": {"code": 400, "message": refusal, "status": "INVALID_ARGUMENT"}}]
        made = sum(1 for message in messages if message.get("role") == "assistant" and message.get("tool_calls"))
        if (messages and messages[-1].get("role") == "tool") or made >= self.steps_with_calls:
            delta = {"role": "assistant", "content": "Done."}
            finish = "stop"
        else:
            arguments, signature = self.issue()
            delta = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "index": 0,
                        "id": f"call-{len(self.issued)}",
                        "type": "function",
                        "function": {"name": TOOL, "arguments": arguments},
                        "extra_content": {"google": {"thought_signature": signature}},
                    }
                ],
            }
            finish = "tool_calls"
        chunk = {"id": "c", "object": "chat.completion.chunk", "created": 0, "model": MODEL}
        return 200, [
            {**chunk, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
            {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
        ]


@contextmanager
def fake_gemini():
    """A FakeGemini on 127.0.0.1, also answering OpenBot's deployment tool callback."""
    _install_loopback_socket_guard()
    gemini = FakeGemini()

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, payload, stream=False):
            if stream and status == 200:
                data = (
                    "".join(f"data: {json.dumps(item)}\n\n" for item in payload) + "data: [DONE]\n\n"
                    if isinstance(payload, list)
                    else f"data: {json.dumps(payload)}\r\n\r\n"
                ).encode()
                kind = "text/event-stream"
            else:
                data = json.dumps(payload).encode()
                kind = "application/json"
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/api/agent-tools/call":
                self.reply(200, {"text": "Card shown."})
                return
            with gemini.lock:
                gemini.requests += 1
            if self.path.startswith("/v1beta/openai/chat/completions"):
                status, payload = gemini.compatible(body)
                if status != 200:
                    gemini.refusals.append(payload)
                self.reply(status, payload, stream=bool(body.get("stream")))
                return
            status, payload = gemini.native(body)
            if status != 200:
                gemini.refusals.append(payload)
            self.reply(status, payload, stream=":streamGenerateContent" in self.path)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", gemini
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def reach_gemini(monkeypatch, base, wire):
    if wire == "native":
        monkeypatch.setenv("BOT_PROVIDER", "google")
        monkeypatch.setenv("GOOGLE_API_KEY", "synthetic-google")
        monkeypatch.setenv("GOOGLE_GENERATIVE_AI_BASE_URL", base)
    else:
        # How OpenBot Desktop reaches Gemini: an OpenAI-compatible endpoint, BOT_PROVIDER unset.
        monkeypatch.setenv("OPENAI_API_KEY", "synthetic-google")
        monkeypatch.setenv("OPENAI_BASE_URL", f"{base}/v1beta/openai")


def body_for(thread, *, deployment=False):
    body = run_body(model={"model": MODEL}, tools=(TOOL,))
    body["messages"] = thread
    if deployment:
        body["forwardedProps"]["openbotDeploymentTools"] = [TOOL]
    return body


def snapshot(events):
    [*_, last] = [event for event in events if event["type"] == "MESSAGES_SNAPSHOT"]
    return last["messages"]


WIRES = [pytest.param("native", id="gemini-api"), pytest.param("compatible", id="openai-compatible")]


@pytest.mark.asyncio
@pytest.mark.parametrize("wire", WIRES)
async def test_a_handed_back_call_keeps_its_signature_into_the_next_run(monkeypatch, wire):
    """The live failure's shape: a UI tool ends the run, and its result comes back in the next."""
    with fake_gemini() as (base, gemini):
        reach_gemini(monkeypatch, base, wire)
        first = finished(
            await run(body_for([{"id": "user-1", "role": "user", "content": "Show me a card."}]))
        )
        [(_, issued)] = gemini.issued.items()

        # The signature leaves on the call, the AG-UI way.
        [call] = [event for event in first if event["type"] == "TOOL_CALL_START"]
        sealed = [event for event in first if event["type"] == "REASONING_ENCRYPTED_VALUE"]
        assert sealed == [
            {
                "type": "REASONING_ENCRYPTED_VALUE",
                "subtype": "tool-call",
                "entityId": call["toolCallId"],
                "encryptedValue": issued,
            }
        ]
        thread = snapshot(first)
        [assistant] = [message for message in thread if message.get("toolCalls")]
        assert [tool_call.get("encryptedValue") for tool_call in assistant["toolCalls"]] == [issued]

        # The server sends the thread back with the caller's result, and the turn goes on.
        thread.append(
            {"id": "tool-1", "role": "tool", "toolCallId": call["toolCallId"], "content": "Card shown."}
        )
        second = await run(body_for(thread))

    assert gemini.refusals == [], gemini.refusals
    finished(second)
    # The signature Gemini gave, not a dummy that only gets past the check.
    assert gemini.returned == [issued]


@pytest.mark.asyncio
@pytest.mark.parametrize("wire", WIRES)
async def test_a_call_answered_in_the_run_keeps_its_signature_for_the_next_step(monkeypatch, wire):
    with fake_gemini() as (base, gemini):
        reach_gemini(monkeypatch, base, wire)
        monkeypatch.setenv("AGENT_TOOL_TOKEN", "synthetic-tool-token")
        monkeypatch.setenv("OPENBOT_TOOL_URL", f"{base}/api/agent-tools/call")
        events = await run(
            body_for([{"id": "user-1", "role": "user", "content": "Show me a card."}], deployment=True)
        )
        [(_, issued)] = gemini.issued.items()

    assert gemini.refusals == [], gemini.refusals
    finished(events)
    assert gemini.returned == [issued]


@pytest.mark.asyncio
async def test_a_signature_reaches_only_gemini(monkeypatch):
    """A thread made on Gemini, now answered by OpenAI: the call goes in OpenAI's shape, unsigned."""
    from harness_contract import fake_provider

    thread = [
        {"id": "user-1", "role": "user", "content": "Show me a card."},
        {
            "id": "assistant-1",
            "role": "assistant",
            "content": "",
            "toolCalls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": TOOL, "arguments": json.dumps({"title": "card 1"})},
                    "encryptedValue": "Z2VtaW5pLXNpZ25hdHVyZS0x",
                }
            ],
        },
        {"id": "tool-1", "role": "tool", "toolCallId": "call-1", "content": "Card shown."},
    ]
    with fake_provider() as (base, bodies):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-synthetic")
        monkeypatch.setenv("OPENAI_BASE_URL", f"{base}/v1")
        monkeypatch.setenv("COPILOTKIT_OPENAI_API", "chat")
        body = run_body(model={"model": "gpt-4o-mini"}, tools=(TOOL,))
        body["messages"] = thread
        finished(await run(body))

    [sent] = bodies
    assert "Z2VtaW5pLXNpZ25hdHVyZS0x" not in json.dumps(sent)
    [assistant] = [message for message in sent["messages"] if message.get("tool_calls")]
    assert [call["id"] for call in assistant["tool_calls"]] == ["call-1"]
    assert "extra_content" not in assistant["tool_calls"][0]
