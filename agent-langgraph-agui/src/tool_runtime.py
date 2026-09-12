"""The current run's tools, with the same ownership contract as agent-langgraph.

Computer/UI tools finish the run for the surface to execute and resume. Only tools
marked by OpenBot's server execute here, through its signed callback. The request
context is deliberately outside graph state: assertions must never enter a
checkpoint, model message, or AG-UI state snapshot.
"""

import asyncio
import os
from contextlib import aclosing
from contextvars import ContextVar
from dataclasses import dataclass, field

import httpx
from ag_ui.core import Context, EventType, RunAgentInput, RunErrorEvent, Tool
from langchain_core.messages import SystemMessage, ToolMessage
from langgraph.graph import END

from .parallel_tools import ParallelToolAgent


@dataclass(frozen=True)
class RunTools:
    tools: tuple[Tool, ...] = ()
    context: tuple[Context, ...] = ()
    deployment: frozenset[str] = frozenset()
    assertion: str = field(default="", repr=False)


_current: ContextVar[RunTools | None] = ContextVar("openbot_run_tools", default=None)


def current_tools() -> RunTools:
    return _current.get() or RunTools()


class UnofferedToolError(ValueError):
    pass


class ToolAwareAgent(ParallelToolAgent):
    async def run(self, input: RunAgentInput):
        props = input.forwarded_props if isinstance(input.forwarded_props, dict) else {}
        names = props.get("openbotDeploymentTools", [])
        assertion = props.get("openbotRun", "")
        context = RunTools(
            tools=tuple(input.tools or []),
            context=tuple(input.context or []),
            deployment=frozenset(name for name in names if isinstance(name, str))
            if isinstance(names, list)
            else frozenset(),
            assertion=assertion if isinstance(assertion, str) else "",
        )
        # The maintained endpoint clones this subclass per request. ContextVar
        # also isolates graph tasks across concurrent requests and resets on
        # cancellation. Current input.tools is authoritative; checkpoint/state
        # tools must not resurrect an offer removed by the caller.
        token = _current.set(context)
        try:
            clean_props = {
                key: value
                for key, value in props.items()
                if key
                not in {
                    "openbotRun",
                    "openbotDeploymentTools",
                    "openbot_run",
                    "openbot_deployment_tools",
                }
            }
            async with aclosing(
                super().run(input.model_copy(update={"forwarded_props": clean_props}))
            ) as stream:
                async for event in stream:
                    yield event
        except UnofferedToolError:
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="The model requested a tool that was not offered for this run.",
            )
        finally:
            _current.reset(token)


def model_messages(messages):
    """Pass AG-UI application context to the model without checkpointing it.

    The maintained integration carries context separately from messages. Our
    graph uses MessagesState, so its answer node must explicitly include the
    current catalog/guidelines instead of silently discarding them.
    """
    return [
        *[
            SystemMessage(content=f"{entry.description}\n{entry.value}")
            for entry in current_tools().context
        ],
        *messages,
    ]


def bind_tools(model):
    tools = current_tools().tools
    if not tools:
        return model
    return model.bind_tools(
        [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                },
            }
            for tool in tools
        ]
    )


def next_step(state):
    calls = state["messages"][-1].tool_calls
    if not calls:
        return END
    context = current_tools()
    offered = {tool.name for tool in context.tools}
    if any(call["name"] not in offered for call in calls):
        raise UnofferedToolError(
            "The model requested a tool that was not offered for this run."
        )
    # Mixed turns yield too: never invent results for a UI component or execute
    # a governed action while the surface still owns an unanswered call.
    if any(call["name"] not in context.deployment for call in calls):
        return END
    return "tools"


async def _call_tool(call, context):
    async def result():
        token = (os.environ.get("AGENT_TOOL_TOKEN") or "").strip()
        if not token:
            return (
                "Refused. This Bot has no credential for calling tools through its deployment.",
                True,
            )
        if not context.assertion:
            return (
                "Refused. This run carried no signed statement of which Bot and person it is for.",
                True,
            )
        url = (
            os.environ.get("OPENBOT_TOOL_URL")
            or "http://127.0.0.1:3001/api/agent-tools/call"
        )
        try:
            # Redirects must never carry this deployment's credential elsewhere.
            async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
                response = await client.post(
                    url,
                    headers={"x-openbot-agent-token": token},
                    json={
                        "name": call["name"],
                        "args": call["args"],
                        "run": context.assertion,
                    },
                )
            if not response.is_success:
                return (
                    f"Refused. Tool callback returned HTTP {response.status_code}.",
                    True,
                )
            body = response.json()
            if not isinstance(body, dict) or not isinstance(body.get("text"), str):
                return "The tool callback returned no readable result.", True
            return body["text"], False
        except (httpx.HTTPError, ValueError):
            # Exception strings can contain URLs. Report the boundary, never its
            # credential-bearing request or response. CancelledError propagates.
            return "The tool callback could not be completed.", True

    text, failed = await result()
    return ToolMessage(
        content=text,
        tool_call_id=call["id"],
        name=call["name"],
        status="error" if failed else "success",
    )


async def execute_tools(state):
    context = current_tools()
    # Recheck ownership at the execution boundary as well as the graph edge.
    if next_step(state) != "tools":
        raise ValueError(
            "This turn must return to the surface before tools can execute."
        )
    results = await asyncio.gather(
        *[_call_tool(call, context) for call in state["messages"][-1].tool_calls]
    )
    return {"messages": results}
