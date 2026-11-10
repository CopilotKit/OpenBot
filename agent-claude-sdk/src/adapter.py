"""Keep client tools inside their original Claude SDK query.

Every new query answers from the whole thread the server sent; see `replay`.

ag-ui-claude-sdk 0.1.5 returns a placeholder from its MCP tool, then sends
the client's real result as a new user prompt. A synchronous PostToolUse hook
replaces that placeholder before Claude sees it. AG-UI requests consume
segments of the same running SDK query, resolving hooks by tool-use ID.

It also keeps a failed tool call failed in the history that ends the turn; see
`_keep_failures`, and passes a reply Claude Code recovered from a broken stream on once; see
`_OneReply`. A large tool result reaches the model whole up to `INLINE_RESULT_CHARS`, the model can
open one Claude Code saved to a file (`own_tool_results_only`), and the history keeps it whole
either way (`_keep_saved_results`).

A turn fits the model's window: the model's own window decides, not one Claude Code assumes
(`UNKNOWN_MODEL_WINDOW`), a full Bot looks up its app tools rather than being sent all of them
(`TOOL_SEARCH`), and a turn the model still refuses as too long is tried once more with every tool
result cut (`_pump`).
"""

import asyncio
import json
import logging
import os
from contextlib import suppress
from dataclasses import dataclass, field, replace
from typing import get_args

from ag_ui.core import EventType, RunErrorEvent, RunFinishedEvent, RunStartedEvent
from ag_ui_claude_sdk import ClaudeAgentAdapter
from ag_ui_claude_sdk.utils import (
    convert_agui_tool_to_claude_sdk,
    create_state_management_tool,
)
from claude_agent_sdk import (
    AssistantMessage,
    CLIConnectionError,
    CLINotFoundError,
    EffortLevel,
    HookMatcher,
    ResultMessage,
    TextBlock,
    ThinkingBlock,
    ToolAnnotations,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    create_sdk_mcp_server,
)
from claude_agent_sdk.types import StreamEvent

from .replay import RESULT_CHARS, cut_note, run_replayed_query, system_instructions

logger = logging.getLogger(__name__)

# The efforts `ClaudeAgentOptions.effort` takes (the CLI's `--effort`), read from the SDK itself.
SDK_EFFORTS = frozenset(get_args(EffortLevel))

AG_UI_TOOL_PREFIX = "mcp__ag_ui__"
# Every tool of the `ag_ui` server, in Claude Code's permission-rule syntax
# (https://code.claude.com/docs/en/permissions: "`mcp__puppeteer__*` matches every tool from the
# `puppeteer` server").
AG_UI_TOOLS = f"{AG_UI_TOOL_PREFIX}*"

# How large a result of one of OpenBot's tools Claude Code keeps in the conversation, in characters.
#
# Claude Code keeps a tool result over 50,000 characters out of the conversation: it saves it to a
# file (`<config>/projects/<cwd>/<session>/tool-results/`) and shows the model a 2 KB preview and the
# path. Every OpenBot tool reaches this harness as an MCP tool, so a page of email, an app's tool
# list or a file the Bot read from its computer (up to 64,000 bytes) crossed it, and the turn's
# history then kept the preview in place of the result. Claude Code lets an MCP tool raise its own
# threshold, to at most 500,000, with `anthropic/maxResultSizeChars` (`ToolAnnotations` in the SDK).
# 100,000 is what Claude Code otherwise lets an MCP tool return (`MAX_MCP_OUTPUT_TOKENS`, 25,000
# tokens at the four characters a token it counts), so a result is never cut there and kept here.
# A replay holds no result longer than this either (`RESULT_CHARS` in `replay`).
INLINE_RESULT_CHARS = RESULT_CHARS

# Claude Code's switch for a model ID it does not know (code.claude.com/docs/en/env-vars).
#
# The Claude Code this harness ships (2.1.259, in claude-agent-sdk 0.2.152) predates Opus 5.5,
# Sonnet 5.5 and Haiku 5.5 (added in 2.1.280, 2.1.284 and 2.1.293), so it does not know the model
# OpenBot runs it on. Since 2.1.223 it holds a session on an unknown ID to the window it assumes for
# one, 200K tokens, and those models have 1M ("prompt is too long: … tokens > 1000000 maximum",
# measured on each). A Bot holding a few apps' tools and its instructions was near 200K before its
# first tool result came back, so the request after it was refused by Claude Code itself, without
# being sent: "Prompt is too long", on the first question of a conversation. Claude Code's own
# compaction could not help, because a replay is one first prompt and there is no earlier exchange
# to summarise (fixed upstream in 2.1.269). With this set, the provider's window decides.
UNKNOWN_MODEL_WINDOW = "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"

# The largest message the SDK reads from Claude Code, in bytes (`ClaudeAgentOptions.max_buffer_size`).
#
# Claude Code reports each tool result to the SDK whole, as one JSON line, even one it saved to a file
# and showed the model only a preview of. The SDK's default is 1 MiB, and a web page larger than that
# ended the turn with "Failed to decode JSON: JSON message exceeded maximum buffer size of 1048576
# bytes" (measured live with a 1.19 MB page). Twice what the server inlines into one run
# (`MAX_INLINED_BYTES_PER_RUN`, 32 MiB), for the JSON escaping around it.
MESSAGE_BUFFER_BYTES = 64 * 1024 * 1024

# Claude Code's file-reading tool, given to a full Bot for its own saved tool results and nothing else.
READ_TOOL = "Read"

# Claude Code's search over the MCP tools a session holds, which loads a tool's definition when the
# model looks for it (code.claude.com/docs/en/mcp, "Scale with MCP tool search").
#
# Left out of `--tools`, Claude Code loads every MCP tool upfront (same page, "Configure tool
# search"), and every one of OpenBot's tools is an MCP tool here. A run carries up to 128 of a Bot's
# app tools (`MODEL_TOOL_LIMIT` in shared/model-tool-limit.ts), so a Bot holding a few apps sent all
# their definitions with every request: measured on the API with 128 real Composio tools and a 50 KB
# standing role, 133,798 input tokens for the first request of a conversation, and 27,932 with this
# tool offered. It runs nothing and reaches nothing outside the session: what it finds is a tool the
# run was already given, called through OpenBot as before.
TOOL_SEARCH = "ToolSearch"

# What a full Bot is told `Read` is for. Its own description says it reads any file on "the local
# filesystem", and the person calls the computer's tool "Read file": asked to read a file on its
# computer, the Bot picked `Read`, was refused, and asked the person what to do.
READ_TOOL_NOTE = (
    "The Read tool opens only a tool result that was too large to show and was saved to a file, "
    "at the path the result names. For files on your computer, use your computer's tools."
)

# What a person is told when Claude Code never started, in place of the process error.
START_FAILED = (
    "This Bot couldn't start, so it didn't answer. Send your message again, and restart "
    "OpenBot if it keeps happening."
)


class ModelAuthenticationError(Exception):
    pass


def too_long(error):
    """Whether a refusal is the request being longer than the model's window.

    Claude Code says "Prompt is too long", and passes the API's own "prompt is too long: … tokens
    > … maximum" on when that is what it was told.
    """
    return isinstance(error, ModelRefusedError) and "prompt is too long" in str(error).lower()


def fitted_result(content):
    """A result the model endpoint can be shown whole: at most `INLINE_RESULT_CHARS`, saying so.

    Claude Code saves a longer one to a file and shows a preview and the path, and a Bot on the
    model endpoint holds no tool that can open it.
    """
    if not isinstance(content, str) or len(content) <= INLINE_RESULT_CHARS:
        return content
    return content[:INLINE_RESULT_CHARS] + cut_note(len(content) - INLINE_RESULT_CHARS)


class ModelRefusedError(Exception):
    """The model provider refused the run, in Claude Code's words for it.

    Claude Code answers a refusal (out of credit, a rate limit, an unknown model, a prompt too long,
    the API down) with an assistant message of its own, marked with `error`. Streamed as one, it read
    as the Bot's answer: "API Error: Request rejected (429) · This request would exceed the rate
    limit …", and the turn finished as if it had worked. It ends the run as a RUN_ERROR instead,
    coded `OPENBOT_MODEL_REFUSED`, and the server says it in words
    (server/src/agents/provider-refusal.ts).
    """


def refusal_text(message):
    """What Claude Code said about a refusal, or a name for it when it said nothing."""
    text = " ".join(
        block.text for block in message.content if isinstance(block, TextBlock) and block.text
    ).strip()
    return text or f"The model provider refused the request ({message.error})."


def not_started(error):
    """Whether this is the SDK saying Claude Code's process was never started.

    The SDK raises `CLIConnectionError` from `connect` with these messages (subprocess_cli.py in
    0.2.152), and also once a running process goes away, which is not a start failure.
    """
    return isinstance(error, CLINotFoundError) or (
        isinstance(error, CLIConnectionError)
        and str(error).startswith(
            ("Failed to start Claude Code", "Working directory does not exist")
        )
    )


def run_model(forwarded_props):
    """The `(model, effort)` the server chose for this run, or `None` when it chose none.

    The server sends `openbotModel: {"model": ..., "reasoningEffort": ...}` on both of this
    harness's paths and strips any a browser supplied, so it is the deployment's decision. A value
    of another shape is ignored. An effort the SDK does not take is not sent, and no effort means
    the model's own default.
    """
    props = forwarded_props if isinstance(forwarded_props, dict) else {}
    choice = props.get("openbotModel")
    if not isinstance(choice, dict):
        return None
    model = choice.get("model")
    if not isinstance(model, str) or not model.strip():
        return None
    effort = choice.get("reasoningEffort")
    return model.strip(), effort if effort in SDK_EFFORTS else None


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
    # Client calls whose result Claude Code saved to a file, and the result the browser sent.
    saved_results: dict[str, str] = field(default_factory=dict)
    # Client calls Claude Code has actually run, and so is waiting on the browser for. See
    # `_hand_to_browser`.
    invoked: set[str] = field(default_factory=set)
    # The assistant message streaming now has ended, so every call in it has reached the browser.
    settled: bool = False
    # The model the server chose when this query started, or that it was switched to since.
    model: str | None = None
    # The newest run's input: the whole thread, with every result the browser has sent so far.
    latest: object = None

    def result(self, tool_id):
        if tool_id not in self.results:
            self.results[tool_id] = asyncio.get_running_loop().create_future()
        return self.results[tool_id]


@dataclass
class _OneReply:
    """Claude Code's recovery from a broken model stream, passed on as the one reply it is.

    Claude Code recovers a model stream that breaks partway (a server error, a lost connection, a
    stall) by itself, in the same query, and the SDK passes on everything it streamed on the way.
    Passed on as it came, the person saw the Bot answer twice:

    - The break came after the reply's text was whole. Claude Code keeps the text, closes the
      message with no stop reason, and asks the model to resume "directly from where it stops - no
      apology, no recap". The model had nothing left to say and said its answer again, in other
      words, as a second message under the first. The end of the broken message and the start of
      the next are held back, so upstream reads the two as one message, and the model's words in
      the second are not passed on. A call it makes there still is.
    - The break came inside the text. Claude Code drops the fragment and the model answers from the
      start: in a new streamed message, or, when no block of the broken one was whole, in one it
      fetches again without streaming and hands over while the broken one is still open. Upstream
      kept that answer under the fragment's id and then wrote the fragment over it, so the person
      was left with the fragment alone. The fragment has already streamed; it is left out of the
      history the turn ends with, which is what the conversation keeps, and the answer is passed on
      as a reply of its own.
    - The stream never started. Claude Code asks again without streaming and hands each block over
      whole, with no stream events. Upstream streams text only from those: it said the reply from
      the turn's result under one id and kept the message itself in the history under another, so
      the reply was drawn twice. A message fetched without streaming is passed on as the stream it
      would have been, its text and calls one message as they are when streamed, ended at its call
      so the client-tool hand-over (`_hand_to_browser`) is not left waiting on it.

    A streamed message with a tool call in it is passed on as it came: the hand-over reads its
    boundaries.
    """

    # The assistant message streaming now: open, its API id, its blocks by index, whether it calls
    # a tool, and whether its last word was a stop with no reason, which is how Claude Code ends a
    # broken one.
    open: bool = False
    stream: str | None = None
    blocks: dict = field(default_factory=dict)
    calls: bool = False
    cut: bool = False
    # Text in it that Claude Code has handed over whole, and text that has streamed and not yet.
    whole: bool = False
    partial: bool = False
    # The reply was whole when its stream broke: the message's end and the next one's start are
    # held back, and the next one is the model saying it again.
    joining: bool = False
    restating: bool = False
    # The text message upstream has open, and the fragments left out of the turn's history.
    speaking: str | None = None
    dropped: set = field(default_factory=set)
    # A message fetched without streaming, being passed on as a stream: open, its API id, and the
    # index of its next block.
    replaying: bool = False
    replay_id: str | None = None
    replay_index: int = 0

    def feed(self, message):
        """What to hand upstream for one SDK message: it, nothing, or it with what it implies."""
        if getattr(message, "parent_tool_use_id", None):
            return [message]
        if isinstance(message, AssistantMessage) and not message.error:
            return self._assistant(message)
        if not isinstance(message, (StreamEvent, UserMessage, ResultMessage)):
            return [message]
        ended = self._end_replay()
        if isinstance(message, StreamEvent):
            return [*ended, *self._event(message)]
        return [*ended, message]

    def mend(self, event):
        """The AG-UI event to pass on for one upstream event."""
        if event.type == EventType.TEXT_MESSAGE_START:
            self.speaking = event.message_id
        if event.type == EventType.TEXT_MESSAGE_END:
            self.speaking = None
        if event.type == EventType.MESSAGES_SNAPSHOT and self.dropped:
            return event.model_copy(
                update={
                    "messages": [
                        message
                        for message in event.messages
                        if message.id not in self.dropped
                    ]
                }
            )
        return event

    def _event(self, message):
        event = message.event
        kind = event.get("type")
        if kind == "message_start":
            self.open, self.blocks, self.calls, self.cut = True, {}, False, False
            self.stream = (event.get("message") or {}).get("id")
            if self.joining:
                self.joining, self.restating = False, True
                return []
            self.restating = self.whole = self.partial = False
            return [message]
        if kind == "content_block_start":
            block = (event.get("content_block") or {}).get("type")
            self.blocks[event.get("index")] = block
            self.calls = self.calls or block == "tool_use"
            self.cut = False
        if kind in ("content_block_start", "content_block_delta", "content_block_stop"):
            if self.restating and self.blocks.get(event.get("index")) in (
                "text",
                "thinking",
                "redacted_thinking",
            ):
                return []
            if (event.get("delta") or {}).get("type") == "text_delta":
                self.partial = True
        if kind == "message_delta":
            self.cut = (event.get("delta") or {}).get("stop_reason") is None
        if kind == "message_stop":
            self.open = False
            if self.cut:
                return self._broke(message)
        return [message]

    def _broke(self, message):
        """The end of a message Claude Code closed with no stop reason: its stream broke, and Claude
        Code goes on with another request in the same query."""
        if self.calls:
            return [message]
        if self.restating or (self.whole and not self.partial):
            # Upstream keeps the message open, and reads the next one as more of it.
            self.open, self.joining = True, True
            return []
        self._drop_fragment()
        return [message]

    def _drop_fragment(self):
        """Leave the text that streamed in this message out of the turn's history, when Claude Code
        never had it whole: the model was not given it, and answers without it."""
        if self.partial and not self.whole and self.speaking:
            self.dropped.add(self.speaking)

    def _assistant(self, message):
        if self.replaying and message.message_id == self.replay_id:
            return self._unstreamed(message)
        # Claude Code names the API message each block came from; one not streamed has its own.
        unstreamed = bool(message.message_id) and message.message_id != self.stream
        if not self.open:
            return self._unstreamed(message) if unstreamed else [*self._end_replay(), message]
        if unstreamed and not self.calls:
            # Fetched again without streaming, while the broken message is still open.
            self._drop_fragment()
            self.open = False
            return [
                self._stream({"type": "message_stop"}),
                *self._unstreamed(message),
            ]
        if self.restating:
            kept = [
                block
                for block in message.content
                if not isinstance(block, (TextBlock, ThinkingBlock))
            ]
            if not kept:
                return []
            return [replace(message, content=kept)]
        if any(isinstance(block, TextBlock) for block in message.content):
            self.whole, self.partial = True, False
        return [message]

    def _unstreamed(self, message):
        """A message Claude Code fetched without streaming, passed on as the stream it would be.

        Claude Code hands such a message over a block at a time, each as its own AssistantMessage
        under the one API id, so blocks under the same id continue the message already open.
        """
        if not any(isinstance(block, (TextBlock, ToolUseBlock)) for block in message.content):
            return [message]
        events = []
        if not (self.replaying and message.message_id == self.replay_id):
            events = self._end_replay()
            events.append(
                self._stream(
                    {"type": "message_start", "message": {"role": "assistant", "content": []}}
                )
            )
            self.replaying, self.replay_id, self.replay_index = True, message.message_id, 0
        called = False
        for block in message.content:
            if isinstance(block, TextBlock):
                start = {"type": "text", "text": ""}
                delta = {"type": "text_delta", "text": block.text}
            elif isinstance(block, ToolUseBlock):
                start = {"type": "tool_use", "id": block.id, "name": block.name}
                delta = {
                    "type": "input_json_delta",
                    "partial_json": json.dumps(block.input),
                }
                called = True
            else:
                continue
            index = self.replay_index
            self.replay_index += 1
            events += [
                self._stream(
                    {"type": "content_block_start", "index": index, "content_block": start}
                ),
                self._stream(
                    {"type": "content_block_delta", "index": index, "delta": delta}
                ),
                self._stream({"type": "content_block_stop", "index": index}),
            ]
        # A call is the last block of its message, and Claude Code runs it now.
        return [*events, message, *(self._end_replay() if called else [])]

    def _end_replay(self):
        if not self.replaying:
            return []
        self.replaying = False
        return [self._stream({"type": "message_stop"})]

    @staticmethod
    def _stream(event):
        return StreamEvent(uuid="openbot-unstreamed", session_id="", event=event)


def _results_kept_inline(input_data):
    """The `ag_ui` MCP server upstream builds, with each tool's results kept in the conversation up
    to `INLINE_RESULT_CHARS`.

    Upstream builds it from this run's tools and, when the run carries state, its state tool, with
    no annotations. The SDK reads a tool's annotations when it builds the server, so it is built
    again rather than amended.
    """
    tools = []
    for tool in input_data.tools or []:
        try:
            tools.append(convert_agui_tool_to_claude_sdk(tool))
        except Exception as error:  # Upstream leaves out a tool it cannot convert, and so does this.
            logger.warning("Failed to convert tool: %s", error)
    if input_data.state is not None:
        tools.append(create_state_management_tool())
    return create_sdk_mcp_server(
        "ag_ui",
        "1.0.0",
        tools=[
            replace(tool, annotations=ToolAnnotations(maxResultSizeChars=INLINE_RESULT_CHARS))
            for tool in tools
        ],
    )


def saved_to_a_file(content):
    """Whether a tool result is Claude Code's notice that it saved the result to a file.

    Claude Code 2.1 words it two ways: `<persisted-output>` ... "Full output saved to: <path>" for a
    result over its size threshold, and "Error: result (...) exceeds maximum allowed tokens. Output
    has been saved to <path>" for an MCP result over `MAX_MCP_OUTPUT_TOKENS`.
    """
    return (
        isinstance(content, str)
        and "/tool-results/" in content
        and ("<persisted-output>" in content or "Output has been saved to" in content)
    )


def saved_results_folder(hook_input):
    """Where Claude Code saves this session's large tool results.

    `<config>/projects/<cwd>/<session>/tool-results`, beside the session's transcript at
    `<config>/projects/<cwd>/<session>.jsonl`; the hook is told both.
    """
    transcript = hook_input.get("transcript_path")
    session = hook_input.get("session_id")
    if not isinstance(transcript, str) or not transcript or not isinstance(session, str) or not session:
        return None
    return os.path.join(os.path.dirname(transcript), session, "tool-results")


async def own_tool_results_only(input_data, tool_use_id, context):
    """Let `Read` open a tool result Claude Code saved for this session, and nothing else.

    A full Bot is given no built-in tools (see `build_options`): its files and commands are on its
    own computer, under OpenBot's policy. Claude Code saves a tool result larger than its threshold
    to a file and tells the model to read it, and the model had nothing that could. `Read` is the
    tool Claude Code expects it to use, and this hook keeps it to this session's own saved results:
    any other path, in this container or anywhere else, is refused.
    """
    if input_data.get("tool_name") != READ_TOOL:
        return {}
    folder = saved_results_folder(input_data)
    path = (input_data.get("tool_input") or {}).get("file_path")
    if folder and isinstance(path, str) and path:
        folder = os.path.realpath(folder)
        target = os.path.realpath(path)
        if target != folder and os.path.commonpath([folder, target]) == folder:
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                }
            }
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "Read only opens a tool result that was saved to a file in "
            "this conversation. For this file, use your computer's tools instead.",
        }
    }


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
        # Read before the model endpoint drops its forwarded props: the server's choice of model
        # is the one prop it honours. Every query is built here, so a choice changed between runs
        # starts the next query on it.
        chosen = run_model(input_data.forwarded_props) if input_data else None
        if self._model_only and input_data:
            # The model endpoint accepts prompts and caller-owned tools, never SDK
            # configuration or an ungoverned state-management tool.
            input_data = input_data.model_copy(
                update={"state": None, "forwarded_props": {}}
            )
        options = super().build_options(input_data, thread_id)
        if chosen:
            # After the upstream merge, so the server's choice wins over a forwarded `model`.
            options.model, options.effort = chosen
        options.env = {**(options.env or {}), UNKNOWN_MODEL_WINDOW: "1"}
        options.max_buffer_size = MESSAGE_BUFFER_BYTES
        if not self._model_only and input_data:
            # The model endpoint gets its instructions in context. A full Bot gets its standing
            # role only as a system message, which a user prompt cannot carry.
            instructions = system_instructions(input_data.messages)
            if instructions:
                options.system_prompt = _with_instructions(
                    options.system_prompt, instructions
                )
        tool_names = {tool.name for tool in input_data.tools} if input_data else set()
        # Upstream allows each `ag_ui` tool by name, and the SDK passes the list to Claude Code as
        # one `--allowedTools` argument, so it grew with every tool a Bot holds. A Bot offered all
        # of HubSpot, Notion and Calendar is offered hundreds. The `ag_ui` server holds exactly this
        # run's tools (and the state tool), so one rule for the server allows the same set.
        options.allowed_tools = [
            rule
            for rule in options.allowed_tools
            if not rule.startswith(AG_UI_TOOL_PREFIX)
        ]
        if "ag_ui" in (options.mcp_servers or {}):
            options.allowed_tools.append(AG_UI_TOOLS)
            options.mcp_servers = {
                **options.mcp_servers,
                "ag_ui": _results_kept_inline(input_data),
            }

        async def client_result(input_data, tool_use_id, context):
            turn = self._turns.get(thread_id)
            name = input_data.get("tool_name", "")
            if name.removeprefix("mcp__ag_ui__") not in tool_names:
                return {}
            if turn is None or turn.cancelled:
                raise asyncio.CancelledError("The client tool query was cancelled")
            if not tool_use_id:
                raise RuntimeError("Claude did not identify the pending client tool")
            # Claude Code ran it, so the browser has a call to answer. See `_hand_to_browser`.
            turn.invoked.add(tool_use_id)
            self._hand_to_browser(turn)
            # The hook can arrive before the event consumer has seen TOOL_CALL_START.
            # Both paths use the SDK ID; names/arguments cannot disambiguate parallel calls.
            content = await turn.result(tool_use_id)
            if self._model_only:
                content = fitted_result(content)
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
            options.allowed_tools = [AG_UI_TOOLS] if tool_names else []
            options.mcp_servers = {
                name: server
                for name, server in options.mcp_servers.items()
                if name == "ag_ui"
            }
            offered = {f"{AG_UI_TOOL_PREFIX}{name}" for name in tool_names}

            async def only_offered(input_data, tool_use_id, context):
                if input_data.get("tool_name") in offered:
                    return {}
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "Built-in Bots may only call tools supplied by the OpenBot server.",
                    }
                }

            options.hooks["PreToolUse"] = [HookMatcher(hooks=[only_offered])]
        else:
            # A full Bot acts through what OpenBot grants it: its computer, its apps, web search,
            # Routines and `run_subagent`, each under the deployment's policy and audit trail.
            # Claude Code's own versions (WebSearch, Bash, Read, CronCreate, Agent, RemoteTrigger
            # and the rest) run in this container instead, ungoverned and unapproved. Left in
            # view, Claude reached for its own WebSearch, was refused, and told the person to
            # grant it. No built-ins, as on the model endpoint; OpenBot's tools still load.
            #
            # Except `Read`, held to the tool results Claude Code saves to a file for this session
            # (`own_tool_results_only`), which is the tool Claude Code tells the model to open one
            # with: a result over `INLINE_RESULT_CHARS`. With no `Read`, the Bot tried its
            # computer's `Read file` on the path, which OpenBot refused for a path outside the Bot's
            # workspace, then `grep` on its computer, a different machine, and lost the result.
            #
            # And `ToolSearch`, which only finds and loads the definitions of the tools this run
            # already holds (see `TOOL_SEARCH`).
            options.tools = [READ_TOOL, TOOL_SEARCH]
            # After the Bot's own instructions, which come first.
            prompt = options.system_prompt
            options.system_prompt = (
                f"{prompt}\n\n{READ_TOOL_NOTE}"
                if isinstance(prompt, str) and prompt
                else _with_instructions(prompt, READ_TOOL_NOTE)
            )
            options.hooks["PreToolUse"] = [
                *options.hooks.get("PreToolUse", []),
                HookMatcher(matcher=READ_TOOL, hooks=[own_tool_results_only]),
            ]
        return options

    async def _run_query(self, input_data, fit_results=False):
        # Never upstream `run`: it sends only the newest message to a worker that remembers the
        # rest, so a restart or an idle eviction forgets the thread. See `replay`.
        async for event in run_replayed_query(self, input_data, fit_results=fit_results):
            yield event

    async def _stream_claude_sdk(
        self, message_stream, thread_id, run_id, input_data, frontend_tool_names
    ):
        # Claude Code's own recovery from a broken model stream, passed on as one reply. See
        # `_OneReply`.
        reply = _OneReply()

        async def repaired():
            async for sent in message_stream:
                for message in reply.feed(sent):
                    yield message

        # Preserve upstream text, reasoning, state, tool and snapshot translation,
        # but do not abandon the SDK stream when a client tool is emitted.
        async def messages():
            streaming = False
            async for message in repaired():
                if (
                    isinstance(message, AssistantMessage)
                    and message.error == "authentication_failed"
                ):
                    turn = self._turns.get(thread_id)
                    if turn:
                        turn.authentication_failed = True
                    # Claude Code's own words stay here, in the log: the sentence below replaces them.
                    logger.warning(
                        "The model provider refused the credential: %s", refusal_text(message)
                    )
                    raise ModelAuthenticationError(
                        "Sign in to your model provider again."
                    )
                if isinstance(message, AssistantMessage) and message.error:
                    raise ModelRefusedError(refusal_text(message))
                if (
                    isinstance(message, StreamEvent)
                    and message.event.get("type") == "message_start"
                ):
                    streaming = True
                    turn = self._turns.get(thread_id)
                    if turn:
                        turn.settled = False
                if isinstance(message, UserMessage) and isinstance(message.content, list):
                    turn = self._turns.get(thread_id)
                    for block in message.content:
                        if not turn or not isinstance(block, ToolResultBlock):
                            continue
                        if block.is_error:
                            turn.failed.add(block.tool_use_id)
                        self._answered_without_browser(turn, block.tool_use_id)
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
                    turn.settled = True
                    self._hand_to_browser(turn)

        async for event in super()._stream_claude_sdk(
            messages(), thread_id, run_id, input_data, set()
        ):
            yield reply.mend(event)

    @staticmethod
    def _hand_to_browser(turn):
        """End this run on the client calls the browser has to answer, once there is one.

        The run ends here and the browser runs the calls, then sends their results in a run of its
        own, which picks the query up again (`run`). Two things have to be true first. The message
        that asked for them has ended, so the browser has every call in it whole. And Claude Code
        has run at least one of them: it can refuse a call itself before running it, for input it
        can't parse, and then nothing waits on the browser. Handed over anyway, the browser had
        nothing to run (the call already had Claude Code's error as its result), sent no run back,
        and the model's own answer to the refusal, a retry or the answer in words, stayed here
        unsent. The person saw the turn stop.

        Claude Code may run a message's calls one at a time, each waiting on the browser before the
        next, so the first one run hands over every call of the message still open.
        """
        ready = turn.ended - turn.announced
        if not turn.settled or not ready & turn.invoked:
            return
        turn.announced.update(ready)
        turn.queue.put_nowait(_ClientBoundary(ready))

    @staticmethod
    def _answered_without_browser(turn, tool_id):
        """Forget a client call Claude Code answered itself before it was handed to the browser.

        Only a refusal does that: a call Claude Code runs is answered with the browser's result,
        after it was handed over. The refused call is no longer waited on, so the run goes on with
        whatever the model does next.
        """
        if tool_id not in turn.offered or tool_id in turn.announced:
            return
        turn.offered.discard(tool_id)
        turn.ended.discard(tool_id)
        pending = turn.results.pop(tool_id, None)
        if pending is not None and not pending.done():
            pending.cancel()

    @staticmethod
    def _keep_saved_results(event, turn):
        """The history at the end of a turn, with a result Claude Code saved to a file in it whole.

        A result over its threshold reaches the model as a preview and a path in this container
        (see `INLINE_RESULT_CHARS`), and that notice is what the turn streamed as the call's result
        and kept in the history it ended with. Every later turn is a new query, in a session of its
        own, so the Bot was left with a path to another session's file and none of the result. For
        a call the browser answered, the browser's own result is put back: the history keeps the
        result, and the replay fits it to its budget like any other.
        """
        if event.type == EventType.TOOL_CALL_RESULT and saved_to_a_file(event.content):
            pending = turn.results.get(event.tool_call_id)
            if pending is None or not pending.done() or pending.cancelled():
                return event
            turn.saved_results[event.tool_call_id] = pending.result()
            turn.failed.discard(event.tool_call_id)
            return event.model_copy(update={"content": pending.result()})
        if event.type != EventType.MESSAGES_SNAPSHOT or not turn.saved_results:
            return event
        return event.model_copy(
            update={
                "messages": [
                    message.model_copy(update={"content": turn.saved_results[message.tool_call_id]})
                    if getattr(message, "role", None) == "tool"
                    and getattr(message, "tool_call_id", None) in turn.saved_results
                    else message
                    for message in event.messages
                ]
            }
        )

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
            try:
                await self._pump_query(input_data, turn)
            except ModelRefusedError as error:
                if not too_long(error) or turn.cancelled:
                    raise
                # Over the model's window. Once more, as a fresh query from the whole thread so
                # far with every tool result cut to its start, this turn's included (`fit_results`
                # in `replay`). Each cut result says how to ask for the rest. Refused again, the
                # person is told, in the server's words for it.
                logger.warning("The model refused the turn as too long; replaying it fitted: %s", error)
                await self._pump_query(turn.latest or input_data, turn, fit_results=True)
        except Exception as error:
            if not_started(error):
                # Claude Code never ran, so this sentence is all the conversation will show. The
                # process error ("[Errno 7] Argument list too long") is for the log.
                logger.error("Claude Code did not start: %s", error)
                await turn.queue.put(
                    RunErrorEvent(message=START_FAILED, code="OPENBOT_HARNESS_START_FAILED")
                )
                return
            await turn.queue.put(
                RunErrorEvent(
                    message=str(error),
                    code="OPENBOT_MODEL_AUTH_REQUIRED"
                    if isinstance(error, ModelAuthenticationError)
                    else "OPENBOT_MODEL_REFUSED"
                    if isinstance(error, ModelRefusedError)
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

    async def _pump_query(self, input_data, turn, fit_results=False):
        async for event in self._run_query(input_data, fit_results=fit_results):
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
            event = self._keep_failures(self._keep_saved_results(event, turn), turn)
            await turn.queue.put(event)

    async def run(self, input_data):
        thread_id, run_id = input_data.thread_id, input_data.run_id
        lock = self._segment_locks.setdefault(thread_id, asyncio.Lock())
        async with lock:
            answer_only = (
                self._model_only
                and (input_data.forwarded_props or {}).get("openbotAnswerOnly") is True
            )
            turn = self._turns.get(thread_id)
            if turn is not None and turn.task.done():
                self._turns.pop(thread_id)
                turn = None
            if turn is not None and all(
                turn.result(tool_id).done() for tool_id in turn.delivered
            ):
                # Nothing it handed out is still waiting for a result, so this query can take no
                # more: it ran out of time while the browser or the person had the step, and is
                # still shutting down. A run only ever finds a live query between its client steps.
                await self.interrupt(thread_id)
                turn = None
            # An SDK query keeps the tools it started with. On the model endpoint the server
            # decides each step's tools, and a step that is sent other tools than the running
            # query holds is answered by a fresh query replaying the real collected results:
            # the last step is sent none, and a step after `search_tools` is sent what it found.
            # Resumed instead, the query never holds a found tool, and Claude called it by the
            # name in the search's text, which is no tool it was given.
            # A person who wrote after the pending call is answered by a fresh query from the
            # whole thread. The browser closes a call it will never finish (Stop, a reload, a
            # tool it only draws) with an "interrupted" result and sends the new message after
            # it; resuming the waiting query took only that result, so the Bot carried on as if
            # nothing had been said, and the turn's snapshot then dropped the person's words
            # from the thread. A continuation that carries only tool results still resumes.
            person_spoke = (
                turn is not None
                and bool(input_data.messages)
                and input_data.messages[-1].role == "user"
            )
            replaced = answer_only or person_spoke or (
                self._model_only
                and turn is not None
                and {tool.name for tool in input_data.tools} != turn.tool_names
            )
            if replaced:
                await self.interrupt(thread_id)
                turn = None
            if answer_only:
                input_data = input_data.model_copy(update={"tools": []})

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
                await self._follow_model_choice(thread_id, turn, input_data)
                turn.latest = input_data
                for tool_id, content in incoming.items():
                    turn.result(tool_id).set_result(content)
                # Parallel client tools may return in separate HTTP requests.
                if any(not turn.result(tool_id).done() for tool_id in turn.delivered):
                    yield RunFinishedEvent(thread_id=thread_id, run_id=run_id)
                    return
            else:
                # A tool result whose query is no longer running is answered by a fresh query that
                # replays the thread, the call and its result included, as a replaced model step is.
                # A query is bounded (`run_replayed_query`), and the person deciding a step OpenBot
                # asked them about routinely takes longer than that bound; a restart ends one too.
                # Refused, the run ended with an error nobody was shown and the Bot never answered
                # the person's decision.
                chosen = run_model(input_data.forwarded_props)
                turn = _Turn(
                    tool_names={tool.name for tool in input_data.tools},
                    model=chosen[0] if chosen else None,
                    latest=input_data,
                )
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

    async def _follow_model_choice(self, thread_id, turn, input_data):
        """Move a running query to the model a tool result's run was sent with.

        A tool result continues the SDK query that asked for it, so its options are the ones that
        query started with. A person can pick another model while a call waits on them, and the
        rest of that turn should answer on it: the SDK changes a running query's model
        (`ClaudeSDKClient.set_model`). It has no such call for effort, so a changed effort applies
        from the next query, which `build_options` starts on it.
        """
        chosen = run_model(input_data.forwarded_props)
        if not chosen or chosen[0] == turn.model:
            return
        worker = (self._workers.get(thread_id) or {}).get("worker")
        client = getattr(worker, "_client", None)
        if client is None:
            return
        try:
            await client.set_model(chosen[0])
        except Exception as error:  # The turn finishes on the model it has rather than failing.
            logger.warning("The running Claude query kept its model: %s", type(error).__name__)
            return
        turn.model = chosen[0]

    async def interrupt(self, thread_id=None):
        threads = [thread_id] if thread_id else list(self._turns)
        for current in threads:
            turn = self._turns.get(current)
            if turn is None:
                continue
            turn.cancelled = True
            # Only this thread's own worker. Upstream interrupts every thread's worker when it is
            # given a thread it no longer holds, which a query that ended on its own no longer is.
            if current in self._workers:
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
