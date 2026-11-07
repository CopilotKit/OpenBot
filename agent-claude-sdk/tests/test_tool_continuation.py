"""Real AG-UI adapter and SDK message types, controlled SDK process boundary.

No provider requests, credentials, or Claude subprocesses. The fake client runs
the configured PostToolUse hooks, just as the SDK does before returning a tool
result to Claude, and records the result seen by that original query.
"""

import asyncio
import json
import sys
from pathlib import Path

import claude_agent_sdk
import pytest
from ag_ui.core import RunAgentInput
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    ToolResultBlock,
    UserMessage,
)
from claude_agent_sdk.types import StreamEvent

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.adapter import OpenBotClaudeAgentAdapter


# Under the bound the slow-turn test sets, and three of them over it.
SLOW_STEP_SECONDS = 0.1


def request(thread="thread-a", run="run-1", results=(), tool_count=1, tool_name="computer_navigate"):
    return RunAgentInput.model_validate(
        {
            "threadId": thread,
            "runId": run,
            "state": {},
            "messages": [
                {"id": "user-1", "role": "user", "content": str(tool_count)},
                *[
                    {
                        "id": f"result-{id}",
                        "role": "tool",
                        "toolCallId": id,
                        "content": text,
                    }
                    for id, text in results
                ],
            ],
            "tools": [
                {
                    "name": tool_name,
                    "description": "Navigate",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
            "context": [{"description": "OpenBot learned skills", "value": "LEARNED_CATALOG_MARKER"}],
            "forwardedProps": {},
        }
    )


def started_with(options):
    """The system prompt Claude Code starts with, read as the CLI reads it.

    A string is `--system-prompt`; `{"type": "file"}` is `--system-prompt-file`, read at start.
    """
    prompt = options.system_prompt
    if isinstance(prompt, dict) and prompt.get("type") == "file":
        return Path(prompt["path"]).read_text(encoding="utf-8")
    return prompt


@pytest.fixture
def tool_name():
    return "computer_navigate"


@pytest.fixture
def sdk(monkeypatch, tool_name):
    clients = []

    class Client:
        def __init__(self, options):
            self.options = options
            self.queries = []
            self.results = {}
            self.interrupted = False
            self.models_set = []
            self.disconnected = False
            self.disconnected_event = asyncio.Event()
            self.hooks_entered = asyncio.Event()
            self.system_prompt = None
            clients.append(self)

        async def connect(self):
            # Claude Code reads its system prompt when it starts, from the file it is given.
            self.system_prompt = started_with(self.options)

        async def disconnect(self):
            self.disconnected = True
            self.disconnected_event.set()

        async def interrupt(self):
            self.interrupted = True

        async def set_model(self, model=None):
            # `ClaudeSDKClient.set_model`: the running query's next request uses `model`.
            self.models_set.append(model)

        async def query(self, prompt, session_id):
            if not isinstance(prompt, str):
                self.input_messages = [message async for message in prompt]
                # Model mode supplies structured user input and image blocks.
                # This fixture's requested tool count is in the last labelled user turn.
                last = None
                for part in self.input_messages[0]["message"]["content"]:
                    if part["type"] == "text" and part["text"].startswith("{"):
                        item = json.loads(part["text"])
                        last = item.get("role")
                        if item.get("role") == "user":
                            prompt = item.get("content", "")
                # A replay that ends on a tool's result is answered, as Claude answers one.
                if last == "tool":
                    prompt = "0"
            self.queries.append((prompt, session_id))

        async def receive_response(self):
            prompt, thread = self.queries[-1]
            if prompt == "auth-failed":
                yield AssistantMessage(
                    content=[], model="controlled-sdk", error="authentication_failed"
                )
                return
            count = 1 if prompt == "slow" else int(prompt) if prompt.isdigit() else 0
            if self.options.tools == [] and not self.options.allowed_tools:
                count = 0
            calls = [
                ToolUseBlock(
                    id=f"{thread}-tool-{i}",
                    name=f"mcp__ag_ui__{tool_name}",
                    input={},
                )
                for i in range(count)
            ]
            if self.options.include_partial_messages:
                raw_events = [
                    {"type": "message_start", "message": {"id": "assistant-message"}},
                    {
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": "Opening the browser."},
                    },
                    {"type": "content_block_stop"},
                ]
                for call in calls:
                    raw_events.extend(
                        [
                            {
                                "type": "content_block_start",
                                "content_block": {
                                    "type": "tool_use",
                                    "id": call.id,
                                    "name": call.name,
                                },
                            },
                            {
                                "type": "content_block_delta",
                                "delta": {
                                    "type": "input_json_delta",
                                    "partial_json": "{}",
                                },
                            },
                            {"type": "content_block_stop"},
                        ]
                    )
                raw_events.append({"type": "message_stop"})
                for raw in raw_events:
                    yield StreamEvent(uuid="stream", session_id=thread, event=raw)
            yield AssistantMessage(content=calls, model="controlled-sdk")

            async def finish_tool(call):
                # This is the CLI's PostToolUse stage, after the MCP response
                # envelope was removed. SDK 0.2.152's bundled MCP output schema
                # accepts string | content-block[] | null; its result-size
                # mapper calls .reduce() on nonstrings. Hooks replace that
                # output directly, NOT the earlier MCP {content: ...} envelope.
                # https://code.claude.com/docs/en/hooks#posttooluse-decision-control
                result = [{"type": "text", "text": "Tool call forwarded to client"}]
                for matcher in (self.options.hooks or {}).get("PostToolUse", []):
                    for hook in matcher.hooks:
                        update = await hook(
                            {
                                "hook_event_name": "PostToolUse",
                                "tool_name": call.name,
                                "tool_input": {},
                                "tool_response": result,
                            },
                            call.id,
                            {},
                        )
                        result = update.get("hookSpecificOutput", {}).get(
                            "updatedMCPToolOutput", result
                        )
                self.results[call.id] = result
                assert result is None or isinstance(result, (str, list)), (
                    "CLI MCP hook output must be content blocks, not a {content: ...} response envelope"
                )

            self.hooks_entered.set()
            await asyncio.gather(*(finish_tool(call) for call in calls))
            yield UserMessage(
                content=[
                    ToolResultBlock(tool_use_id=id, content=result)
                    for id, result in self.results.items()
                ]
            )
            if prompt == "slow":
                # A Bot still working: a step's worth of thinking between each thing it says.
                for _ in range(3):
                    await asyncio.sleep(SLOW_STEP_SECONDS)
                    yield AssistantMessage(
                        content=[TextBlock(text="Still working.")],
                        model="controlled-sdk",
                    )
            yield AssistantMessage(
                content=[TextBlock(text=json.dumps(self.results))],
                model="controlled-sdk",
            )
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id=thread,
            )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Client)
    return clients


async def events(adapter, input_data):
    async with asyncio.timeout(2):
        return [event async for event in adapter.run(input_data)]


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("model_only", [False, True])
@pytest.mark.parametrize("tool_name", ["computer_navigate", "copilotkit_load_skill", "copilotkit_read_skill_file"])
def test_client_result_resumes_original_sdk_query(sdk, streaming, model_only, tool_name):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(
            name="test",
            options={"include_partial_messages": streaming},
            model_only=model_only,
        )
        try:
            first = await events(adapter, request(tool_name=tool_name))
            assert any(event.type == "TOOL_CALL_END" for event in first)
            opened = [
                event.message_id
                for event in first
                if event.type == "TEXT_MESSAGE_START"
            ]
            closed = [
                event.message_id for event in first if event.type == "TEXT_MESSAGE_END"
            ]
            assert opened == closed, (
                "finish the assistant's text before handing off client tools"
            )
            resumed = await events(
                adapter,
                request(
                    run="run-2",
                    tool_name=tool_name,
                    results=[
                        (
                            "thread-a-tool-0",
                            '{"url":"https://example.com","title":"Example Domain"}',
                        )
                    ],
                ),
            )
            assert "LEARNED_CATALOG_MARKER" in sdk[0].system_prompt
            assert sdk[0].queries == [("1", "thread-a")], (
                "a tool result must not become another SDK user prompt"
            )
            assert sdk[0].results["thread-a-tool-0"] == [
                {
                    "type": "text",
                    "text": '{"url":"https://example.com","title":"Example Domain"}',
                }
            ]
            assert resumed[0].type == "RUN_STARTED"
            assert resumed[-1].type == "RUN_FINISHED"
            assert any(
                event.type == "TOOL_CALL_RESULT"
                and event.tool_call_id == "thread-a-tool-0"
                for event in resumed
            )
            assert all(
                getattr(event, "run_id", "run-2") == "run-2" for event in resumed
            )
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("separate_requests", [False, True])
@pytest.mark.parametrize("model_only", [False, True])
def test_parallel_calls_with_identical_arguments_keep_distinct_results(
    sdk, separate_requests, model_only
):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test", model_only=model_only)
        try:
            first = await events(adapter, request(tool_count=2))
            assert any(
                getattr(event, "tool_call_id", None) == "thread-a-tool-0"
                for event in first
            )
            assert any(
                getattr(event, "tool_call_id", None) == "thread-a-tool-1"
                for event in first
            )
            results = [
                ("thread-a-tool-0", "first result"),
                ("thread-a-tool-1", "second result"),
            ]
            if separate_requests:
                second = await events(
                    adapter, request(run="run-2", results=results[:1], tool_count=2)
                )
                assert [event.type for event in second] == [
                    "RUN_STARTED",
                    "RUN_FINISHED",
                ]
                await events(
                    adapter, request(run="run-3", results=results[1:], tool_count=2)
                )
            else:
                await events(
                    adapter,
                    request(run="run-2", results=list(reversed(results)), tool_count=2),
                )
            assert sdk[0].queries == [("2", "thread-a")]
            assert sdk[0].results == {
                "thread-a-tool-0": [{"type": "text", "text": "first result"}],
                "thread-a-tool-1": [{"type": "text", "text": "second result"}],
            }
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("model_only", [False, True])
def test_unknown_id_cannot_resolve_another_threads_tool(sdk, model_only):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test", model_only=model_only)
        try:
            await events(adapter, request())
            await events(adapter, request(thread="thread-b"))
            wrong = await events(
                adapter,
                request(
                    thread="thread-b",
                    run="wrong",
                    results=[("thread-a-tool-0", "foreign")],
                ),
            )
            assert wrong[-1].type == "RUN_ERROR"
            assert all(not client.results for client in sdk)
            await events(
                adapter, request(run="a-ok", results=[("thread-a-tool-0", "a result")])
            )
            await events(
                adapter,
                request(
                    thread="thread-b",
                    run="b-ok",
                    results=[("thread-b-tool-0", "b result")],
                ),
            )
            assert sdk[0].results["thread-a-tool-0"][0]["text"] == "a result"
            assert sdk[1].results["thread-b-tool-0"][0]["text"] == "b result"
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("model_only", [False, True])
def test_interrupt_cancels_pending_tool_without_fabricating_a_result(sdk, model_only):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test", model_only=model_only)
        await events(adapter, request())
        await asyncio.wait_for(sdk[0].hooks_entered.wait(), 2)
        await asyncio.wait_for(adapter.interrupt("thread-a"), 2)
        await asyncio.wait_for(adapter.shutdown(), 2)
        assert sdk[0].interrupted
        assert sdk[0].disconnected
        assert not sdk[0].results

    asyncio.run(scenario())


def test_disconnected_event_consumer_cancels_the_sdk_query(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test")
        stream = adapter.run(request())
        assert (await anext(stream)).type == "RUN_STARTED"
        assert (await anext(stream)).type == "STATE_SNAPSHOT"
        await asyncio.wait_for(stream.aclose(), 2)
        assert sdk[0].interrupted
        assert sdk[0].disconnected
        assert not sdk[0].results
        stale = await events(
            adapter, request(run="stale", results=[("thread-a-tool-0", "late result")])
        )
        # The cancelled query never receives it; a fresh query answers it from the thread.
        assert not sdk[0].results
        assert stale[-1].type == "RUN_FINISHED"
        assert len(sdk) == 2
        await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("model_only", [False, True])
def test_query_timeout_interrupts_sdk_before_abandoning_client_result(sdk, model_only):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(
            name="test", query_timeout_seconds=0.02, model_only=model_only
        )
        try:
            first = await events(adapter, request())
            assert first[-1].type == "RUN_FINISHED"
            await asyncio.wait_for(sdk[0].disconnected_event.wait(), 2)
            assert sdk[0].interrupted, (
                "timeout must send the SDK an interrupt, not only cancel a Python future"
            )
            assert not sdk[0].results
            assert "thread-a" not in adapter._workers, (
                "timed-out SDK worker must not be reused"
            )
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("model_only", [False, True])
def test_a_result_after_its_query_ended_is_answered_from_the_thread(sdk, model_only):
    """The person decides a step OpenBot asked them about after the query that asked has ended.

    A query is bounded, and a hand-off or an approval routinely takes longer than the bound. The
    decision still reaches the Bot: a fresh query replays the thread, the call and the person's
    answer included, and the Bot says what came of it. It used to end the run with an error nobody
    was shown, so the person who answered never heard back.
    """

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(
            name="test", query_timeout_seconds=0.02, model_only=model_only
        )
        try:
            first = await events(adapter, request())
            assert any(event.type == "TOOL_CALL_END" for event in first)
            await asyncio.wait_for(sdk[0].disconnected_event.wait(), 2)
            declined = "The person declined this action when you asked for their approval, so it was not done."
            answer = await events(
                adapter, request(run="decided", results=[("thread-a-tool-0", declined)])
            )
            assert [event.message for event in answer if event.type == "RUN_ERROR"] == []
            assert answer[-1].type == "RUN_FINISHED"
            assert any(event.type == "TEXT_MESSAGE_CONTENT" for event in answer), (
                "the Bot answers the decision"
            )
            assert not sdk[0].results, "nothing reaches the query that ended"
            assert len(sdk) == 2
            replayed = json.dumps(sdk[1].input_messages)
            assert "thread-a-tool-0" in replayed and "declined this action" in replayed
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("model_only", [False, True])
def test_a_query_that_keeps_working_is_not_cut_off_at_the_bound(sdk, model_only):
    """The bound ends a query that has stopped moving, not one that is still working.

    Counted from the start, it ended a Bot nine browser steps into a form, mid-turn, with an error
    the person never saw. Each event now pushes the deadline back.
    """

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(
            name="test", query_timeout_seconds=0.25, model_only=model_only
        )
        try:
            first = await events(adapter, request(tool_count="slow"))
            assert any(event.type == "TOOL_CALL_END" for event in first)
            finished = await events(
                adapter,
                request(run="run-2", tool_count="slow", results=[("thread-a-tool-0", "done")]),
            )
            assert [event.message for event in finished if event.type == "RUN_ERROR"] == []
            assert finished[-1].type == "RUN_FINISHED"
            assert len(sdk) == 1, "the same query carried on to the end"
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("model_only", [False, True])
def test_sdk_authentication_signal_is_typed(sdk, model_only):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test", model_only=model_only)
        try:
            result = await events(adapter, request(tool_count="auth-failed"))
            assert result[-1].type == "RUN_ERROR"
            assert result[-1].code == "OPENBOT_MODEL_AUTH_REQUIRED"
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("model_only", [False, True])
def test_person_message_after_a_pending_tool_is_answered_not_dropped(sdk, model_only):
    """A person who writes while a client tool is still pending is heard.

    The browser answers a call it will never finish (Stop, a reload, a tool it only draws) with
    an "interrupted" result, and sends the person's new message after it in the same request.
    Resuming the waiting query with that result alone answered the stale call and dropped the
    person's words: the Bot carried on as if they had said nothing, and the turn's final
    snapshot left their message out of the thread.
    """

    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="test", model_only=model_only)
        try:
            first = await events(adapter, request())
            assert any(event.type == "TOOL_CALL_END" for event in first)
            follow_up = request(
                run="run-2",
                results=[
                    (
                        "thread-a-tool-0",
                        "This call produced no result: the surface was interrupted before it could answer.",
                    )
                ],
            )
            follow_up.messages.append(
                follow_up.messages[0].model_copy(
                    update={"id": "user-2", "content": "Seattle"}
                )
            )
            answered = await events(adapter, follow_up)
            assert sdk[0].interrupted, "the stale query must be stopped, not resumed"
            assert not sdk[0].results, (
                "the stale call must not be completed with the interruption as its result"
            )
            assert len(sdk) == 2, "the person's message starts a fresh query"
            assert sdk[1].queries[-1][0] == "Seattle", (
                "the person's words must reach Claude"
            )
            assert answered[-1].type == "RUN_FINISHED"
            assert any(event.type == "TEXT_MESSAGE_CONTENT" for event in answered)
            snapshots = [
                event for event in answered if event.type == "MESSAGES_SNAPSHOT"
            ]
            assert all(
                any(
                    getattr(message, "content", None) == "Seattle"
                    for message in snapshot.messages
                )
                for snapshot in snapshots
            ), "the thread kept after the turn must still hold the person's message"
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())


def test_model_last_step_replaces_pending_query_with_tool_free_replay(sdk):
    async def scenario():
        adapter = OpenBotClaudeAgentAdapter(name="model", model_only=True)
        try:
            first = await events(adapter, request())
            assert any(event.type == "TOOL_CALL_END" for event in first)
            final = request(run="final", results=[("thread-a-tool-0", "Collected source")])
            final.tools = []
            final.forwarded_props = {"openbotAnswerOnly": True}
            answer = await events(adapter, final)
            assert len(sdk) == 2
            assert sdk[0].interrupted
            assert sdk[0].disconnected
            assert sdk[1].options.tools == []
            assert sdk[1].options.allowed_tools == []
            assert "Collected source" in str(sdk[1].input_messages)
            assert any(event.type == "TEXT_MESSAGE_CONTENT" for event in answer)
            assert not any(event.type == "TOOL_CALL_START" for event in answer)
            assert answer[-1].type == "RUN_FINISHED"
        finally:
            await adapter.shutdown()

    asyncio.run(scenario())
