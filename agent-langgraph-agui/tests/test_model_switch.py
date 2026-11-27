"""Switching models mid-conversation, between providers and back: every run answers.

AG-UI has no idea of a provider. A provider's opaque parts of an earlier turn ride on the thread
as `encryptedValue`: on a `reasoning` row (OpenAI's encrypted reasoning, a reference into OpenAI's
own store; Anthropic's thinking signature) and on a tool call (Gemini's thought signature).
Nothing in the row says which provider sealed it, and no other provider can use it. So on a
switch the new provider is sent none of it; every visible turn and every tool result stays; and
every earlier call and its result are sent in the new provider's own shape, whoever made them.
Switching back to the first provider works the same way.

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

GEMINI_SEALED = "CiQB-gemini-thought-signature"

ASTRA = {
    "provider": "openai",
    "model": "gpt-6.2-astra",
    "effort": "high",
    "call": "call_Wq3nX8pL2vR7",
    "sealed": "gAAAAB-openai-encrypted-reasoning",
}
OPUS = {
    "provider": "anthropic",
    "model": "claude-opus-5-5",
    "effort": "xhigh",
    "call": "toolu_01AbCdEfGhIjKlMn",
    "sealed": "EqQBCkYIBxgCKkA-anthropic-thinking-signature",
}
CITIES = ["Paris", "London"]


def thread_across(sides):
    """A thread where each side in turn reasoned, called the weather tool and was answered."""
    messages = []
    for index, side in enumerate(sides):
        city = CITIES[index]
        messages += [
            {"id": f"user-{index}", "role": "user", "content": f"What is the weather in {city}?"},
            {
                "id": f"reasoning-{index}",
                "role": "reasoning",
                "content": "The person wants the weather; call the tool.",
                "encryptedValue": side["sealed"],
            },
            {
                "id": f"assistant-{index}",
                "role": "assistant",
                "content": f"Checking {city}.",
                "toolCalls": [
                    {
                        "id": side["call"],
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": json.dumps({"city": city})},
                        "encryptedValue": GEMINI_SEALED,
                    }
                ],
            },
            {
                "id": f"tool-{index}",
                "role": "tool",
                "toolCallId": side["call"],
                "content": f"Sunny, {21 + index} degrees in {city}.",
            },
        ]
    return messages + [{"id": "user-last", "role": "user", "content": "Thanks. Say pineapple."}]


async def sent_on(monkeypatch, side, thread):
    """Run the thread on `side`'s model and answer with the one request its provider got."""
    with fake_provider() as (base, bodies):
        if side["provider"] == "anthropic":
            monkeypatch.setenv("BOT_PROVIDER", "anthropic")
            monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-synthetic")
            monkeypatch.setenv("ANTHROPIC_BASE_URL", base)
        else:
            monkeypatch.setenv("BOT_PROVIDER", "openai")
            monkeypatch.setenv("OPENAI_API_KEY", "sk-synthetic")
            monkeypatch.setenv("OPENAI_BASE_URL", f"{base}/v1")
        body = run_body(
            model={"model": side["model"], "reasoningEffort": side["effort"]},
            tools=("get_weather",),
        )
        body["messages"] = thread
        finished(await run(body))
    [sent] = bodies
    return sent


def calls_and_results(side, body):
    """The call ids the body carries, as calls and as results, in its provider's own shape."""
    if side["provider"] == "anthropic":
        blocks = [
            block
            for message in body["messages"]
            if isinstance(message["content"], list)
            for block in message["content"]
        ]
        assert all(block.get("type") not in ("thinking", "redacted_thinking", "reasoning") for block in blocks)
        return (
            [block["id"] for block in blocks if block.get("type") == "tool_use"],
            [block["tool_use_id"] for block in blocks if block.get("type") == "tool_result"],
        )
    items = body["input"]
    assert all(item.get("type") != "reasoning" for item in items)
    return (
        [item["call_id"] for item in items if item.get("type") == "function_call"],
        [item["call_id"] for item in items if item.get("type") == "function_call_output"],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "earlier, now",
    [
        pytest.param([ASTRA], OPUS, id="astra-to-opus"),
        pytest.param([ASTRA, OPUS], ASTRA, id="astra-to-opus-and-back"),
        pytest.param([OPUS], ASTRA, id="opus-to-astra"),
        pytest.param([OPUS, ASTRA], OPUS, id="opus-to-astra-and-back"),
    ],
)
async def test_a_switch_between_providers_answers_with_a_valid_history(monkeypatch, earlier, now):
    thread = thread_across(earlier)
    body = await sent_on(monkeypatch, now, thread)

    sent = json.dumps(body)
    assert body["model"] == now["model"]
    # No provider's opaque reasoning, not even this provider's own from an earlier turn.
    for sealed in [side["sealed"] for side in earlier] + [GEMINI_SEALED]:
        assert sealed not in sent, f"{sealed} reached {now['provider']}"
    # Every visible turn and every tool result stays.
    for message in thread:
        if message["role"] in ("user", "tool") or message.get("content", "").startswith("Checking"):
            assert message["content"] in sent, f"{message['content']!r} is missing"
    # Every earlier call and its result, whoever made it, in this provider's own shape.
    calls, results = calls_and_results(now, body)
    made = [side["call"] for side in earlier]
    assert calls == made
    assert results == made
    if now["provider"] == "anthropic":
        assert body.get("output_config") == {"effort": now["effort"]}
