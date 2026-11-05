"""Keep client tools inside their original Claude SDK query.

Every new query answers from the whole thread the server sent; see `replay`.

ag-ui-claude-sdk 0.1.5 returns a placeholder from its MCP tool, then sends
the client's real result as a new user prompt. A synchronous PostToolUse hook
replaces that placeholder before Claude sees it. AG-UI requests consume
segments of the same running SDK query, resolving hooks by tool-use ID.

It also keeps a failed tool call failed in the history that ends the turn; see
`_keep_failures`.
"""

import asyncio
from contextlib import suppress
from dataclasses import dataclass, field

from ag_ui.core import EventType, RunErrorEvent, RunFinishedEvent, RunStartedEvent
from ag_ui_claude_sdk import ClaudeAgentAdapter
from claude_agent_sdk import AssistantMessage, HookMatcher, ToolResultBlock, UserMessage
from claude_agent_sdk.types import StreamEvent

from .replay import run_replayed_query, system_instructions


class ModelAuthenticationError(Exception):
    pass


@dataclass
class _ClientBoundary:
    tool_ids: set[str]


@dataclass
class _Turn:
    tool_names: set[str]
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    results: dict[str, asyncio.Future] = field(default_factory=dict)
    offered: set[str] = field(default_factory=set)
    ended: set[str] = field(default_factory=set)
    announced: set[str] = field(default_factory=set)
    delivered: set[str] = field(default_factory=set)
    task: asyncio.Task | None = None
    cancelled: bool = False
    authentication_failed: bool = False
    # Tool calls Claude Code reported as failed, and the result the turn streamed for each.
    failed: set[str] = field(default_factory=set)
    failed_results: dict[str, str] = field(default_factory=dict)

    def result(self, tool_id):
        if tool_id not in self.results:
            self.results[tool_id] = asyncio.get_running_loop().create_future()
        return self.results[tool_id]


def _with_instructions(system_prompt, instructions):
    """The server's instructions first, then whatever the adapter already put there."""
    if isinstance(system_prompt, dict):  # A preset keeps its own prompt; add to its append.
        append = system_prompt.get("append")
        return {
            **system_prompt,
            "append": f"{instructions}\n\n{append}" if append else instructions,
        }
    return f"{instructions}\n\n{system_prompt}" if system_prompt else instructions


class OpenBotClaudeAgentAdapter(ClaudeAgentAdapter):
    def __init__(self, *args, model_only=False, **kwargs):
        super().__init__(*args, **kwargs)
        self._model_only = model_only
        self._turns: dict[str, _Turn] = {}
        self._segment_locks: dict[str, asyncio.Lock] = {}

    def build_options(self, input_data=None, thread_id=None):
        if self._model_only and input_data:
            # The model endpoint accepts prompts and caller-owned tools, never SDK
            # configuration or an ungoverned state-management tool.
            input_data = input_data.model_copy(
                update={"state": None, "forwarded_props": {}}
            )
        options = super().build_options(input_data, thread_id)
        if not self._model_only and input_data:
            # The model endpoint gets its instructions in context. A full Bot gets its standing
            # role only as a system message, which a user prompt cannot carry.
            instructions = system_instructions(input_data.messages)
            if instructions:
                options.system_prompt = _with_instructions(
                    options.system_prompt, instructions
                )
        tool_names = {tool.name for tool in input_data.tools} if input_data else set()

        async def client_result(input_data, tool_use_id, context):
            turn = self._turns.get(thread_id)
            name = input_data.get("tool_name", "")
            if name.removeprefix("mcp__ag_ui__") not in tool_names:
                return {}
            if turn is None or turn.cancelled:
                raise asyncio.CancelledError("The client tool query was cancelled")
            if not tool_use_id:
                raise RuntimeError("Claude did not identify the pending client tool")
            # The hook can arrive before the event consumer has seen TOOL_CALL_START.
            # Both paths use the SDK ID; names/arguments cannot disambiguate parallel calls.
            content = await turn.result(tool_use_id)
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    # At PostToolUse the CLI has removed the MCP response
                    # envelope. Replacement is tool_result.content itself.
                    "updatedMCPToolOutput": [{"type": "text", "text": content}],
                }
            }

        options.hooks = {
            **(options.hooks or {}),
            "PostToolUse": [
                *(options.hooks or {}).get("PostToolUse", []),
                HookMatcher(
                    matcher="mcp__ag_ui__.*",
                    hooks=[client_result],
                    timeout=(self._query_timeout_seconds or 300) + 10,
                ),
            ],
        }
        if self._model_only:
            options.tools = []  # SDK 0.2.152 maps this to --tools "": no Bash/Read/Edit.
            options.setting_sources = []
            options.strict_mcp_config = True
            options.permission_mode = "dontAsk"
            options.allowed_tools = [
                f"mcp__ag_ui__{name}" for name in sorted(tool_names)
            ]
            options.mcp_servers = {
                name: server
                for name, server in options.mcp_servers.items()
                if name == "ag_ui"
            }

            async def only_offered(input_data, tool_use_id, context):
                if input_data.get("tool_name") in options.allowed_tools:
                    return {}
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "Built-in Bots may only call tools supplied by the OpenBot server.",
                    }
                }

            options.hooks["PreToolUse"] = [HookMatcher(hooks=[only_offered])]
        return options

    async def _run_query(self, input_data):
        # Never upstream `run`: it sends only the newest message to a worker that remembers the
        # rest, so a restart or an idle eviction forgets the thread. See `replay`.
        async for event in run_replayed_query(self, input_data):
            yield event

    async def _stream_claude_sdk(
        self, message_stream, thread_id, run_id, input_data, frontend_tool_names
    ):
        # Preserve upstream text, reasoning, state, tool and snapshot translation,
        # but do not abandon the SDK stream when a client tool is emitted.
        async def messages():
            streaming = False
            async for message in message_stream:
                if (
                    isinstance(message, AssistantMessage)
                    and message.error == "authentication_failed"
                ):
                    turn = self._turns.get(thread_id)
                    if turn:
                        turn.authentication_failed = True
                    raise ModelAuthenticationError(
                        "Sign in to your model provider again."
                    )
                if (
                    isinstance(message, StreamEvent)
                    and message.event.get("type") == "message_start"
                ):
                    streaming = True
                if isinstance(message, UserMessage) and isinstance(message.content, list):
                    turn = self._turns.get(thread_id)
                    for block in message.content:
                        if turn and isinstance(block, ToolResultBlock) and block.is_error:
                            turn.failed.add(block.tool_use_id)
                yield message
                complete = isinstance(message, AssistantMessage) and not streaming
                if (
                    isinstance(message, StreamEvent)
                    and message.event.get("type") == "message_stop"
                ):
                    streaming = False
                    complete = True
                if complete:
                    turn = self._turns[thread_id]
                    ready = turn.ended - turn.announced
                    if ready:
                        turn.announced.update(ready)
                        await turn.queue.put(_ClientBoundary(ready))

        async for event in super()._stream_claude_sdk(
            messages(), thread_id, run_id, input_data, set()
        ):
            yield event

    @staticmethod
    def _keep_failures(event, turn):
        """The history at the end of a turn, with each failed call as the turn streamed it.

        AG-UI has no field for a failed tool result, so ag-ui-claude-sdk marks one in the
        TOOL_CALL_RESULT it streams, as `{"error": true, "content": "..."}`. The MESSAGES_SNAPSHOT
        it sends when the turn ends is built from the bare result, which drops the mark, and that
        snapshot is the history a reloaded conversation draws. A refused write or a blocked
        command then read as having worked. Each failed call's snapshot entry is given the result
        it streamed, so the two say the same thing.
        """
        if event.type == EventType.TOOL_CALL_RESULT and event.tool_call_id in turn.failed:
            turn.failed_results[event.tool_call_id] = event.content
            return event
        if event.type != EventType.MESSAGES_SNAPSHOT or not turn.failed_results:
            return event
        return event.model_copy(
            update={
                "messages": [
                    message.model_copy(update={"content": turn.failed_results[message.tool_call_id]})
                    if getattr(message, "role", None) == "tool"
                    and getattr(message, "tool_call_id", None) in turn.failed_results
                    else message
                    for message in event.messages
                ]
            }
        )

    async def _pump(self, input_data, turn):
        try:
            async for event in self._run_query(input_data):
                if event.type == EventType.RUN_ERROR and turn.authentication_failed:
                    event = event.model_copy(
                        update={"code": "OPENBOT_MODEL_AUTH_REQUIRED"}
                    )
                if (
                    event.type == EventType.TOOL_CALL_START
                    and event.tool_call_name in turn.tool_names
                ):
                    turn.offered.add(event.tool_call_id)
                    turn.result(event.tool_call_id)
                if (
                    event.type == EventType.TOOL_CALL_END
                    and event.tool_call_id in turn.offered
                ):
                    turn.ended.add(event.tool_call_id)
                event = self._keep_failures(event, turn)
                await turn.queue.put(event)
        except Exception as error:
            await turn.queue.put(
                RunErrorEvent(
                    message=str(error),
                    code="OPENBOT_MODEL_AUTH_REQUIRED"
                    if isinstance(error, ModelAuthenticationError)
                    else None,
                )
            )
        finally:
            # Cancellation/timeout must never substitute a made-up successful result.
            # Upstream reports a query timeout without stopping its SDK worker.
            # Stop the CLI before cancelling hooks, which otherwise leave that
            # separate process waiting for a callback response that will never arrive.
            stop_worker = not turn.cancelled and any(
                not result.done() for result in turn.results.values()
            )
            if stop_worker:
                turn.cancelled = True
                await super().interrupt(input_data.thread_id)
            for result in turn.results.values():
                if not result.done():
                    result.cancel()
            if stop_worker:
                with suppress(asyncio.CancelledError):
                    await super().clear_session(input_data.thread_id)
            await turn.queue.put(None)

    async def run(self, input_data):
        thread_id, run_id = input_data.thread_id, input_data.run_id
        lock = self._segment_locks.setdefault(thread_id, asyncio.Lock())
        async with lock:
            answer_only = (
                self._model_only
                and (input_data.forwarded_props or {}).get("openbotAnswerOnly") is True
            )
            if answer_only:
                # An SDK query keeps the tools it started with. The last model step must
                # replay the real collected results in a fresh query with no tools, rather
                # than resume a query that can keep calling them until the step cap.
                await self.interrupt(thread_id)
                input_data = input_data.model_copy(update={"tools": []})
            turn = self._turns.get(thread_id)
            if turn is not None and turn.task.done():
                self._turns.pop(thread_id)
                turn = None

            yield RunStartedEvent(thread_id=thread_id, run_id=run_id)
            if turn is not None:
                incoming = {
                    message.tool_call_id: message.content
                    for message in input_data.messages
                    if message.role == "tool"
                    and message.tool_call_id in turn.delivered
                    and not turn.result(message.tool_call_id).done()
                }
                if not incoming:
                    yield RunErrorEvent(
                        message="This Claude query is waiting for its client tool result; no matching tool-use ID was supplied."
                    )
                    return
                for tool_id, content in incoming.items():
                    turn.result(tool_id).set_result(content)
                # Parallel client tools may return in separate HTTP requests.
                if any(not turn.result(tool_id).done() for tool_id in turn.delivered):
                    yield RunFinishedEvent(thread_id=thread_id, run_id=run_id)
                    return
            else:
                if (
                    not answer_only
                    and input_data.messages
                    and input_data.messages[-1].role == "tool"
                ):
                    yield RunErrorEvent(
                        message="The Claude query for this tool result is no longer running. Start a new message."
                    )
                    return
                turn = _Turn(tool_names={tool.name for tool in input_data.tools})
                self._turns[thread_id] = turn
                turn.task = asyncio.create_task(self._pump(input_data, turn))

            released = False
            try:
                while True:
                    event = await turn.queue.get()
                    if event is None:
                        raise RuntimeError(
                            "Claude query ended without a terminal event"
                        )
                    if isinstance(event, _ClientBoundary):
                        turn.delivered.update(event.tool_ids)
                        released = True
                        yield RunFinishedEvent(thread_id=thread_id, run_id=run_id)
                        return
                    if event.type == EventType.RUN_STARTED:
                        continue
                    # The SDK query keeps its original run ID internally; each HTTP
                    # continuation is nevertheless a new AG-UI run to its consumer.
                    update = {"run_id": run_id, "thread_id": thread_id}
                    yield event.model_copy(update=update)
                    if event.type in (EventType.RUN_FINISHED, EventType.RUN_ERROR):
                        released = True
                        await turn.task
                        self._turns.pop(thread_id, None)
                        return
            finally:
                if not released:
                    await self.interrupt(thread_id)

    async def interrupt(self, thread_id=None):
        threads = [thread_id] if thread_id else list(self._turns)
        for current in threads:
            turn = self._turns.get(current)
            if turn is None:
                continue
            turn.cancelled = True
            await super().interrupt(current)
            for result in turn.results.values():
                if not result.done():
                    result.cancel()
            turn.task.cancel()
            with suppress(asyncio.CancelledError):
                await turn.task
            with suppress(asyncio.CancelledError):
                await super().clear_session(current)
            self._turns.pop(current, None)

    async def shutdown(self):
        await self.interrupt()
        await super().shutdown()
        self._segment_locks.clear()
