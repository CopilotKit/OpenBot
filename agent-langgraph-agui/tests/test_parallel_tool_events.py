"""Real SDK/AG-UI stream boundaries, including events before snapshots repair them."""

import asyncio
import json
from contextlib import aclosing
from importlib.metadata import version

import pytest
from ag_ui.core import RunAgentInput
from src import main
from src.tool_runtime import ToolAwareAgent
from test_tool_protocol import run_input, run_protocol, snapshot

pytest_plugins = ("test_tool_protocol",)


def calls_from_events(events):
    calls = {}
    for event in events:
        kind = event["type"]
        if kind == "TOOL_CALL_START":
            cid = event["toolCallId"]
            assert cid not in calls, "a tool call must start exactly once"
            calls[cid] = {"args": "", "end": 0, "parent": event["parentMessageId"]}
        elif kind == "TOOL_CALL_ARGS":
            call = calls[event["toolCallId"]]
            assert call["end"] == 0, "argument after tool end"
            call["args"] += event["delta"]
        elif kind == "TOOL_CALL_END":
            calls[event["toolCallId"]]["end"] += 1
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize("shape", ["batched", "interleaved", "sequential"])
async def test_every_call_has_complete_args_before_snapshot(boundary, shape):
    boundary["shape"] = shape
    boundary["text_with_tools"] = True
    names = ["computer_navigate", "computer_run_command"]
    events = await run_protocol(run_input(names))
    calls = calls_from_events(events)
    assert set(calls) == {"call-" + name for name in names}
    for call in calls.values():
        assert call["end"] == 1
        assert json.loads(call["args"]) == {"value": "public marker"}
    text = [e for e in events if e["type"] == "TEXT_MESSAGE_CONTENT"]
    assert "".join(e["delta"] for e in text) == "Using the computer."
    assert {call["parent"] for call in calls.values()} == {text[0]["messageId"]}
    assert boundary["callback"] == []
    owner = next(m for m in snapshot(events) if m.get("toolCalls"))
    assert {call["id"] for call in owner["toolCalls"]} == set(calls)
    for call in owner["toolCalls"]:
        assert json.loads(call["function"]["arguments"]) == json.loads(
            calls[call["id"]]["args"]
        )


@pytest.mark.asyncio
async def test_atomic_first_chunk_includes_arguments(boundary):
    events = await run_protocol(run_input(["computer_navigate"]))
    call = calls_from_events(events)["call-computer_navigate"]
    assert call["end"] == 1
    assert json.loads(call["args"]) == {"value": "public marker"}


@pytest.mark.asyncio
async def test_abandoned_run_does_not_leave_parallel_tool_slots(boundary):
    boundary["shape"] = "batched"
    agent = ToolAwareAgent(name="openbot", graph=main.graph)
    stream = agent.run(
        RunAgentInput.model_validate(
            run_input(["computer_navigate", "computer_run_command"])
        )
    )
    async for event in stream:
        if event.type == "TOOL_CALL_START":
            break
    await stream.aclose()
    assert agent._tool_streams == {}
    events = [
        e.model_dump(by_alias=True)
        async for e in agent.run(
            RunAgentInput.model_validate(run_input(["computer_run_command"]))
        )
    ]
    calls = calls_from_events(events)
    assert set(calls) == {"call-computer_run_command"}
    assert calls["call-computer_run_command"]["end"] == 1
    assert agent._tool_streams == {}


@pytest.mark.asyncio
async def test_cancelled_consumer_closes_graph_and_resets_call_state(boundary):
    agent = ToolAwareAgent(name="openbot", graph=main.graph)
    started = asyncio.Event()
    hold = asyncio.Event()

    async def consume():
        async with aclosing(
            agent.run(RunAgentInput.model_validate(run_input(["computer_navigate"])))
        ) as stream:
            async for event in stream:
                if event.type == "TOOL_CALL_START":
                    started.set()
                    await hold.wait()

    task = asyncio.create_task(consume())
    await asyncio.wait_for(started.wait(), timeout=5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert agent._tool_streams == {}
    assert agent.active_run is None
    assert agent._graph_stream.ag_frame is None


@pytest.mark.asyncio
async def test_batched_deployment_calls_keep_each_signed_result_and_model_turn(
    boundary,
):
    boundary["shape"] = "batched"
    boundary["all_results"] = True
    names = ["granted_one", "granted_two"]
    events = await run_protocol(run_input(names, deployment=names))
    calls = calls_from_events(events)
    assert set(calls) == {"call-" + name for name in names}
    assert all(call["end"] == 1 for call in calls.values())
    assert {c["body"]["name"] for c in boundary["callback"]} == set(names)
    assert all(
        c["body"]["run"] == "synthetic-run-assertion" for c in boundary["callback"]
    )
    assert len(boundary["model"]) == 2
    results = [m for m in boundary["model"][-1]["messages"] if m["role"] == "tool"]
    assert {m["tool_call_id"] for m in results} == set(calls)


def test_compatibility_adapter_runs_against_exact_shipped_release():
    assert version("ag-ui-langgraph") == "0.0.45"
