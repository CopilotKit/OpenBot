"""Exercise learned skill reads through the real bundled framework."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "agent-adk"))

from learning_harness_contract import assert_learning_delivery


def test_learned_catalog_and_both_read_tools_reach_the_model(monkeypatch):
    assert_learning_delivery(monkeypatch, "agent-adk", "/")


def test_partial_tool_arguments_wait_without_dropping_neighboring_text(monkeypatch):
    import asyncio
    import importlib
    from google.adk.models.lite_llm import LiteLlm
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types

    monkeypatch.setenv("BOT_MODEL", "gpt-4.1-mini")
    main = importlib.import_module("src.main")

    async def provider(self, request, stream=False):
        yield LlmResponse(partial=True, content=types.Content(role="model", parts=[
            types.Part(text="Looking up the policy."),
            types.Part(function_call=types.FunctionCall(id="call", name="copilotkit_load_skill", will_continue=True)),
        ]))
        yield LlmResponse(partial=False, content=types.Content(role="model", parts=[
            types.Part(function_call=types.FunctionCall(id="call", name="copilotkit_load_skill", args={"skill_name": "refunds"})),
        ]))

    monkeypatch.setattr(LiteLlm, "generate_content_async", provider)

    async def collect():
        model = main.CompleteToolCallsLiteLlm(model="openai/gpt-4.1-mini")
        return [response async for response in model.generate_content_async(None, True)]

    responses = asyncio.run(collect())
    assert responses[0].content.parts == [types.Part(text="Looking up the policy.")]
    assert responses[1].content.parts[0].function_call.args == {"skill_name": "refunds"}
    assert responses[1].content.parts[0].function_call.id == "call"
