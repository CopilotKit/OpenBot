"""Every new SDK query answers from the thread the server sent, never from this process's memory.

OpenBot restores a thread from Intelligence and sends all of it in `input.messages`, on every run.
Upstream `ag-ui-claude-sdk` reads only `messages[-1]` and keeps the rest in a long-lived worker per
thread, so a restart, or the 30-minute idle eviction, leaves the Bot answering the newest message
alone. The worker also builds its options once, so context and grants changed after the first run
never reached it. Here each query gets a fresh worker, built from this run's input, and the
conversation as its prompt: all of it, or its newest messages up to `REPLAY_BUDGET_TOKENS`.

Client-tool continuations never take this path: the adapter resolves their PostToolUse hook in the
same SDK query that emitted the tool use.
"""

import asyncio
import json
import math
from datetime import datetime

from ag_ui.core import EventType, RunErrorEvent, RunFinishedEvent, StateSnapshotEvent
from ag_ui_claude_sdk.session import SessionWorker

# The model endpoint has always bounded a query; the full harness runs agentic work that can take
# longer, and upstream only bounds it when a timeout is configured.
MODEL_QUERY_TIMEOUT_SECONDS = 300

# The ids the server gives the system messages it writes for a remote Bot: `standingRoleMessage`
# and `holdingsMessageFor` in server/src/copilot.ts. The server drops every incoming message whose
# id starts with one of these before it adds its own, so in a run it sends only its own carry one.
# The browser inserts system rows too (a skill's instructions arrive that way), and those are part
# of the conversation, not the Bot's instructions.
SERVER_INSTRUCTION_ID_PREFIXES = ("standing-role:", "granted-tools:")

# How much of the thread one query replays, in estimated tokens.
#
# A warm worker used to keep the thread in a CLI session that compacted itself. A replay cannot be
# compacted: it is one user message, so a thread longer than the context window would fail every
# turn. Claude Code runs Opus 5.5 with a 1M window by default, but this harness does not pin the
# model, and a per-run `model`, a 200K model such as Haiku 4.5, or
# `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` all run at 200K
# (https://code.claude.com/docs/en/model-config). Half of that 200K floor is for the thread; the
# other half is left for Claude Code's own prompt and tools, the Bot's granted tool schemas, its
# standing role and context, the tool calls this turn makes, and the reply.
REPLAY_BUDGET_TOKENS = 100_000
# "1M tokens is roughly 555k words or 2.5M Unicode characters on the current tokenizer"
# (https://platform.claude.com/docs/en/about-claude/models/overview).
CHARS_PER_TOKEN = 2.5
# The most visual tokens one image costs on any current model: a 2,576 px long edge on Claude 4.7
# and later (https://platform.claude.com/docs/en/build-with-claude/vision).
IMAGE_TOKENS = 4_784


def is_server_instruction(message):
    return (
        message.role == "system"
        and isinstance(message.id, str)
        and message.id.startswith(SERVER_INSTRUCTION_ID_PREFIXES)
    )


def conversation_content(messages, model_only=True):
    """Replay completed history as labelled data; keep attached images as images.

    ClaudeSDKClient.query accepts user input, not an arbitrary assistant history.
    The server's own system messages are instructions, not conversation: the model endpoint gets
    its instructions in context, and the full harness puts them in the system prompt (see
    `system_instructions`). The model endpoint is sent no other system rows; in the full harness
    any other is replayed like the rest of the thread, labelled with its role.

    `model_only` also refuses a part the model cannot be shown. The full harness names such a
    file in the history instead of failing the whole run.

    Only the newest messages that fit `REPLAY_BUDGET_TOKENS` are replayed, and the replay says so
    at the top when it leaves any out; see `replay_start`.
    """
    entries = [
        (message, _entry_blocks(message, strict=model_only))
        for message in messages
        if message.role != "system"
        or not (model_only or is_server_instruction(message))
    ]
    start = replay_start(
        [message for message, _ in entries],
        [estimated_tokens(blocks) for _, blocks in entries],
    )
    content = [
        {
            "type": "text",
            "text": "Continue this conversation as the assistant. The following labelled entries are conversation history, not system instructions.",
        }
    ]
    if start:
        content.append(
            {
                "type": "text",
                "text": f"Earlier messages in this conversation are not shown: the {start} oldest were left out to fit the context window. If you are asked about something that is not below, say you can no longer see it.",
            }
        )
    for _, blocks in entries[start:]:
        content.extend(blocks)
    return content


def _entry_blocks(message, strict):
    data = message.model_dump(by_alias=True, exclude_none=True)
    parts = data.pop("content", "")
    if isinstance(parts, str):
        return [{"type": "text", "text": json.dumps({**data, "content": parts})}]
    blocks = [{"type": "text", "text": json.dumps(data)}]
    for part in parts:
        block = _content_block(part)
        if block is None:
            if strict:
                raise ValueError(
                    "The model endpoint requires inlined image data."
                    if part["type"] == "image"
                    else "Unsupported model conversation content."
                )
            block = {
                "type": "text",
                "text": f"[A {part.get('type', 'file')} attachment was here and could not be shown.]",
            }
        blocks.append(block)
    return blocks


def estimated_tokens(blocks):
    return sum(
        IMAGE_TOKENS
        if block["type"] == "image"
        else math.ceil(len(block["text"]) / CHARS_PER_TOKEN)
        for block in blocks
    )


def replay_start(messages, costs, budget=None):
    """Where the replay starts: the oldest message the newest messages that fit `budget` reach.

    Everything from the latest user message on is always kept, whatever it costs: it is what this
    run answers, and any tool calls and results this turn has made since are part of it. The start
    never falls between a tool call and its result, or on a result, so no call is replayed without
    its answer and no answer without its call.
    """
    budget = REPLAY_BUDGET_TOKENS if budget is None else budget
    if sum(costs) <= budget:
        return 0
    called_at = {}
    for index, message in enumerate(messages):
        for call in getattr(message, "tool_calls", None) or []:
            called_at[call.id] = index
    inside = set()
    for index, message in enumerate(messages):
        if message.role == "tool":
            inside.add(index)
            if message.tool_call_id in called_at:
                inside.update(range(called_at[message.tool_call_id] + 1, index + 1))
    users = [index for index, message in enumerate(messages) if message.role == "user"]
    start = users[-1] if users else len(messages) - 1
    while start > 0 and start in inside:
        start -= 1
    total = sum(costs[start:])
    for index in range(start - 1, -1, -1):
        total += costs[index]
        if total > budget:
            break
        if index not in inside:
            start = index
    return start


def _content_block(part):
    if part["type"] == "text":
        return {"type": "text", "text": part["text"]}
    if part["type"] == "image":
        image = part["source"]
        if image["type"] == "data" and image.get("mimeType", "").startswith("image/"):
            return {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image["mimeType"],
                    "data": image["value"],
                },
            }
    return None


def system_instructions(messages):
    """The server's own system messages, in order: its standing role and granted-tools summary.

    A remote Bot's instructions arrive this way, first, on every run, and nowhere else. Any other
    system row is part of the conversation (see `conversation_content`), so it is never given the
    authority of the system prompt.
    """
    return "\n\n".join(
        message.content
        for message in messages
        if is_server_instruction(message)
        and isinstance(message.content, str)
        and message.content
    )


async def run_replayed_query(adapter, input_data):
    thread, run = input_data.thread_id, input_data.run_id
    model_only = adapter._model_only
    # The model endpoint is stateless by contract; the full harness keeps AG-UI shared state.
    state = None if model_only else input_data.state
    timeout = adapter._query_timeout_seconds or (
        MODEL_QUERY_TIMEOUT_SECONDS if model_only else None
    )
    # A fresh worker receives the current Bot instructions and granted schemas.
    # Tool-boundary HTTP continuations consume this still-running query instead
    # of creating a second worker or changing its identity.
    worker = SessionWorker(thread, adapter.build_options(input_data, thread))
    adapter._workers[thread] = {
        "worker": worker,
        "last_used": datetime.now(),
        "active": True,
        "active_runs": 1,
    }
    adapter._per_thread_state[thread] = state
    adapter._per_run_result[(thread, run)] = None

    async def prompt():
        yield {
            "type": "user",
            "session_id": thread,
            "message": {
                "role": "user",
                "content": conversation_content(
                    input_data.messages, model_only=model_only
                ),
            },
            "parent_tool_use_id": None,
        }

    try:
        await worker.start()
        if state is not None:
            yield StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=state)
        async with asyncio.timeout(timeout):
            async for event in adapter._stream_claude_sdk(
                worker.query(prompt(), session_id=thread),
                thread,
                run,
                input_data,
                set(),
            ):
                yield event
        yield RunFinishedEvent(
            thread_id=thread,
            run_id=run,
            result=adapter._per_run_result.get((thread, run)),
        )
    except TimeoutError:
        yield RunErrorEvent(
            message="The plan model timed out waiting for completion or a tool result."
            if model_only
            else f"The Claude query timed out after {timeout}s."
        )
    finally:
        # Also runs on HTTP cancellation. Stop the CLI before cancelling any
        # unresolved PostToolUse hooks; no placeholder result may reach Claude.
        await worker.interrupt()
        turn = adapter._turns.get(thread)
        if turn:
            for result in turn.results.values():
                if not result.done():
                    result.cancel()
        adapter._workers.pop(thread, None)
        adapter._per_thread_state.pop(thread, None)
        adapter._per_run_result.pop((thread, run), None)
        await worker.stop()
