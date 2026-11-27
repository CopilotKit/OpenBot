"""Switching models mid-conversation, between providers: the next run answers.

AG-UI has no idea of a provider. A provider's own sealed parts of an earlier turn ride on the
thread as `encryptedValue`: on a `reasoning` row (OpenAI's encrypted reasoning, Anthropic's
thinking signature) and on a tool call (Gemini's thought signature). Nothing in the row says
which provider sealed it, so when the person picks another provider's model, the next run must
not hand those parts to the new provider, which can't read them and may refuse the request. A
call and its result stay, in the new provider's own shape.

Every check goes through the production AG-UI endpoint, on the request body the provider gets.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))

from harness_contract import fake_provider
from test_model_choice import environment, finished, run, run_body  # noqa: F401

OPENAI_SEALED = "gAAAAB-openai-encrypted-reasoning"
ANTHROPIC_SEALED = "EqQBCkYIBxgCKkA-anthropic-thinking-signature"
GEMINI_SEALED = "CiQB-gemini-thought-signature"


def switched_thread(call_id, sealed):
    """A thread answered on another provider: its reasoning, a tool call and its result."""
    return [
        {"id": "user-1", "role": "user", "content": "What is the weather in Paris?"},
        {
            "id": "rs_earlier",
            "role": "reasoning",
            "content": "The person wants the weather; call the tool.",
            "encryptedValue": sealed,
        },
        {
            "id": "assistant-1",
            "role": "assistant",
            "content": "",
            "toolCalls": [
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": "get_weather", "arguments": json.dumps({"city": "Paris"})},
                    "encryptedValue": GEMINI_SEALED,
                }
            ],
        },
        {"id": "tool-1", "role": "tool", "toolCallId": call_id, "content": "Sunny, 21 degrees."},
        {"id": "assistant-2", "role": "assistant", "content": "It is sunny and 21 degrees."},
        {"id": "user-2", "role": "user", "content": "Thanks. Say pineapple."},
    ]


def body_on(model, effort, thread):
    body = run_body(
        model={"model": model, **({"reasoningEffort": effort} if effort else {})},
        tools=("get_weather",),
    )
    body["messages"] = thread
    return body


@pytest.mark.asyncio
async def test_openai_to_claude_opus_at_extra_high(monkeypatch):
    with fake_provider() as (base, bodies):
        monkeypatch.setenv("BOT_PROVIDER", "anthropic")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-synthetic")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", base)
        finished(
            await run(
                body_on("claude-opus-5-5", "xhigh", switched_thread("call_Wq3nX8pL2vR7", OPENAI_SEALED))
            )
        )

    [body] = bodies
    sent = json.dumps(body)
    assert body["model"] == "claude-opus-5-5"
    assert body.get("output_config") == {"effort": "xhigh"}
    for sealed in (OPENAI_SEALED, GEMINI_SEALED):
        assert sealed not in sent, f"{sealed} reached Anthropic"
    blocks = [
        block
        for message in body["messages"]
        if isinstance(message["content"], list)
        for block in message["content"]
    ]
    assert all(block.get("type") not in ("thinking", "redacted_thinking", "reasoning") for block in blocks)
    use = next(block for block in blocks if block.get("type") == "tool_use")
    result = next(block for block in blocks if block.get("type") == "tool_result")
    assert use["id"] == "call_Wq3nX8pL2vR7"
    assert result["tool_use_id"] == "call_Wq3nX8pL2vR7"


@pytest.mark.asyncio
async def test_claude_to_openai_responses_model(monkeypatch):
    with fake_provider() as (base, bodies):
        monkeypatch.setenv("BOT_PROVIDER", "openai")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-synthetic")
        monkeypatch.setenv("OPENAI_BASE_URL", f"{base}/v1")
        finished(
            await run(
                body_on("gpt-5.6-terra", "high", switched_thread("toolu_01AbCdEfGhIjKlMn", ANTHROPIC_SEALED))
            )
        )

    [body] = bodies
    sent = json.dumps(body)
    for sealed in (ANTHROPIC_SEALED, GEMINI_SEALED):
        assert sealed not in sent, f"{sealed} reached OpenAI"
    items = body.get("input") or body.get("messages")
    assert all(item.get("type") != "reasoning" for item in items)
    calls = [item for item in items if item.get("type") == "function_call"]
    outputs = [item for item in items if item.get("type") == "function_call_output"]
    assert [call["call_id"] for call in calls] == ["toolu_01AbCdEfGhIjKlMn"]
    assert [output["call_id"] for output in outputs] == ["toolu_01AbCdEfGhIjKlMn"]
