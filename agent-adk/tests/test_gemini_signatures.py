"""Which requests `shared/gemini_signatures.py` signs, and which it leaves byte for byte.

The module is shared by every Python harness; its rules are checked once, here. Each harness's
`test_gemini_handback.py` checks that the harness actually installs it.
"""

import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
import gemini_signatures
from gemini_signatures import GEMINI_UNSIGNED_CALL, is_gemini_model, signed_body

GOOGLE = "https://generativelanguage.googleapis.com"
COMPAT = f"{GOOGLE}/v1beta/openai/chat/completions"


def _chat(model="gemini-3.8-flash", extra=None):
    call = {"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{}"}}
    if extra is not None:
        call["extra_content"] = extra
    return json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": None, "tool_calls": [call]},
                {"role": "tool", "tool_call_id": "c1", "content": "{}"},
            ],
        }
    ).encode()


def _contents(signature=None):
    part = {"functionCall": {"name": "f", "args": {}}}
    if signature is not None:
        part["thoughtSignature"] = signature
    return json.dumps(
        {
            "contents": [
                {"role": "user", "parts": [{"text": "hi"}]},
                {"role": "model", "parts": [part, {"function_call": {"name": "g", "args": {}}}]},
                {"role": "user", "parts": [{"functionResponse": {"name": "f", "response": {}}}]},
            ]
        }
    ).encode()


def _signatures(body):
    parsed = json.loads(body)
    if "messages" in parsed:
        return [
            ((call.get("extra_content") or {}).get("google") or {}).get("thought_signature")
            for message in parsed["messages"]
            for call in message.get("tool_calls") or []
        ]
    return [
        part.get("thoughtSignature")
        for content in parsed["contents"]
        for part in content["parts"]
        if "functionCall" in part or "function_call" in part
    ]


@pytest.mark.parametrize(
    "model",
    ["gemini-4-hydrogen", "gemini-3.8-flash", "models/gemini-4-neon", "google/gemini-4-carbon"],
)
def test_gemini_models_are_gemini(model):
    assert is_gemini_model(model)


@pytest.mark.parametrize("model", ["gpt-5.5", "claude-sonnet-5-5", "gemma-4-31b-it", None, ""])
def test_other_models_are_not(model):
    assert not is_gemini_model(model)


@pytest.mark.parametrize(
    "path", [":generateContent", ":streamGenerateContent"]
)
def test_gemini_native_calls_are_signed_on_any_host(path):
    for base in (f"{GOOGLE}/v1beta", "http://127.0.0.1:9/gateway/v1beta"):
        body = signed_body("POST", f"{base}/models/gemini-4-hydrogen{path}?alt=sse", _contents())
        assert _signatures(body) == [GEMINI_UNSIGNED_CALL, GEMINI_UNSIGNED_CALL]


def test_a_signature_already_there_is_kept():
    body = signed_body(
        "POST", f"{GOOGLE}/v1beta/models/gemini-3.8-flash:generateContent", _contents("real")
    )
    assert _signatures(body) == ["real", GEMINI_UNSIGNED_CALL]
    assert (
        signed_body("POST", COMPAT, _chat(extra={"google": {"thought_signature": "real"}})) is None
    )


def test_a_native_request_for_another_model_is_left_alone():
    assert signed_body("POST", f"{GOOGLE}/v1beta/models/gemma-4-31b-it:generateContent", _contents()) is None


def test_googles_compatible_endpoint_is_signed_in_extra_content():
    body = signed_body("POST", COMPAT, _chat(extra={"other": 1}))
    call = json.loads(body)["messages"][1]["tool_calls"][0]
    assert call["extra_content"] == {
        "other": 1,
        "google": {"thought_signature": GEMINI_UNSIGNED_CALL},
    }


def test_openbots_gateway_is_signed_for_a_gemini_model():
    url = "http://openbot:3010/api/model-provider/v1/chat/completions"
    assert _signatures(signed_body("POST", url, _chat())) == [GEMINI_UNSIGNED_CALL]
    assert signed_body("POST", url, _chat(model="gpt-5.5")) is None


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com/v1/chat/completions",
        "https://openrouter.ai/api/v1/chat/completions",
        "http://localhost:11434/v1/chat/completions",
    ],
)
def test_another_provider_is_never_touched_even_for_a_gemini_name(url):
    assert signed_body("POST", url, _chat()) is None


def test_a_non_gemini_model_on_googles_endpoint_is_left_alone():
    assert signed_body("POST", COMPAT, _chat(model="gemma-4-31b-it")) is None


def test_nothing_to_sign_and_not_json_are_left_alone():
    assert signed_body("GET", COMPAT, _chat()) is None
    assert signed_body("POST", COMPAT, b"not json") is None
    assert signed_body("POST", COMPAT, None) is None
    plain = json.dumps({"model": "gemini-3.8-flash", "messages": [{"role": "user", "content": "hi"}]})
    assert signed_body("POST", COMPAT, plain.encode()) is None


def test_an_httpx_request_is_sent_signed():
    gemini_signatures.install()
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        assert int(request.headers["content-length"]) == len(request.content)
        return httpx.Response(200, json={})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        client.post(COMPAT, content=_chat(), headers={"content-type": "application/json"})
        client.post("https://api.openai.com/v1/chat/completions", content=_chat())
    assert _signatures(json.dumps(seen[0]).encode()) == [GEMINI_UNSIGNED_CALL]
    assert _signatures(json.dumps(seen[1]).encode()) == [None]
