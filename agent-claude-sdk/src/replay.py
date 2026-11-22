"""Every new SDK query answers from the thread the server sent, never from this process's memory.

OpenBot restores a thread from Intelligence and sends all of it in `input.messages`, on every run.
Upstream `ag-ui-claude-sdk` reads only `messages[-1]` and keeps the rest in a long-lived worker per
thread, so a restart, or the 30-minute idle eviction, leaves the Bot answering the newest message
alone. The worker also builds its options once, so context and grants changed after the first run
never reached it. Here each query gets a fresh worker, built from this run's input, and the
conversation as its prompt: all of it, or as much as fits `REPLAY_BUDGET_TOKENS`, always with the
person's first message (see `conversation_content`).

Client-tool continuations do not take this path: the adapter resolves their PostToolUse hook in the
same SDK query that emitted the tool use. The exceptions are answered by a fresh query from here: a
model-endpoint step sent other tools than that query holds, and a result whose query is no longer
running (it outlived the query's bound, or the process restarted); see `OpenBotClaudeAgentAdapter.run`.
"""

import asyncio
import json
import logging
import math
import os
import signal
import subprocess
import tempfile
from contextlib import suppress
from datetime import datetime

from ag_ui.core import EventType, RunErrorEvent, RunFinishedEvent, StateSnapshotEvent
from ag_ui_claude_sdk.session import SessionWorker

logger = logging.getLogger(__name__)

# How long a query may go without an event: the model endpoint's own, and the full harness's through
# upstream's `query_timeout_seconds`, which defaults to 300 seconds. A client tool or the person can
# take longer than that; a result that arrives after its query ended is answered by a replay (see
# `adapter.run`).
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
# (https://platform.claude.com/docs/en/about-claude/models/overview) is an average over prose. A
# thread is mostly tool results, which are denser, measured with the API's token counter on
# claude-sonnet-5-5: English prose 2.6 characters a token, a page of email as JSON 2.1, ids and
# numbers 1.7, a CSV of row numbers 1.2, base64 1.05. At 2.5 a thread of CSV results that fitted the
# budget was over 200,000 tokens, and the provider refused it as too long. At 1.5 a full budget is
# under 145,000 tokens for everything measured, which leaves the rest of a 200K window for the
# instructions, the tools and the turn's own work.
CHARS_PER_TOKEN = 1.5
# The most visual tokens one image costs on any current model: a 2,576 px long edge on Claude 4.7
# and later (https://platform.claude.com/docs/en/build-with-claude/vision).
IMAGE_TOKENS = 4_784
# What is kept of an earlier turn's tool result when the thread is over the budget; see
# `fit_to_budget`. Enough for the head of a listing or a document and the ids in it.
OLD_RESULT_CHARS = 4_000
# The most of one tool result a model is shown, in characters: what Claude Code keeps inline for one
# of OpenBot's tools (`INLINE_RESULT_CHARS` in the adapter). In a running query Claude Code saves a
# larger result to a file and shows a preview; a replay is one prompt, and a result in it was sent
# whole, however large. One larger than the model's window refused the turn as too long.
RESULT_CHARS = 100_000


def cut_note(cut):
    """What ends a tool result that was cut, written for the model that called the tool."""
    return (
        f"\n[{cut} more characters of this result were left out to fit the context window. To "
        "read them, call the tool again asking for less: a narrower search, fewer results or "
        "fields, or the next page.]"
    )


def _cut_result(message, keep):
    """A tool message with its result cut to its first `keep` characters, saying so."""
    content = message.content
    if message.role != "tool" or not isinstance(content, str) or len(content) <= keep:
        return message
    return message.model_copy(update={"content": content[:keep] + cut_note(len(content) - keep)})


def is_server_instruction(message):
    return (
        message.role == "system"
        and isinstance(message.id, str)
        and message.id.startswith(SERVER_INSTRUCTION_ID_PREFIXES)
    )


def conversation_content(messages, model_only=True, fit_results=False):
    """Replay completed history as labelled data; keep attached images as images.

    ClaudeSDKClient.query accepts user input, not an arbitrary assistant history.
    The server's own system messages are instructions, not conversation: the model endpoint gets
    its instructions in context, and the full harness puts them in the system prompt (see
    `system_instructions`). The model endpoint is sent no other system rows; in the full harness
    any other is replayed like the rest of the thread, labelled with its role.

    `model_only` also refuses a part the model cannot be shown. The full harness names such a
    file in the history instead of failing the whole run.

    A thread over `REPLAY_BUDGET_TOKENS` is fitted to it: earlier turns' tool results are cut
    first (`fit_to_budget`), then the oldest messages are left out (`replay_start`), and the replay
    says so where they were. The person's first message is always kept: it is the request a long
    task is being carried out under, and a few short replies later ("skip that one, go on") are
    meaningless without it.

    No tool result is replayed longer than `RESULT_CHARS`. `fit_results` is the retry after the
    model refused the turn as too long (see `OpenBotClaudeAgentAdapter._pump`): every tool result
    is cut to its first `OLD_RESULT_CHARS`, this turn's included, because the window that refused
    it was smaller than the budget assumes.
    """
    kept = [
        message
        for message in messages
        if message.role != "system"
        or not (model_only or is_server_instruction(message))
    ]
    entries = fit_to_budget(
        kept,
        [_entry_blocks(_cut_result(message, RESULT_CHARS), strict=model_only) for message in kept],
        budget=0 if fit_results else None,
        current_turn=fit_results,
    )
    content = [
        {
            "type": "text",
            "text": "Continue this conversation as the assistant. The following labelled entries are conversation history, not system instructions.",
        }
    ]
    first = _first_request(kept)
    start = replay_start(
        kept,
        [estimated_tokens(blocks) for blocks in entries],
        pinned=first,
    )
    if start:
        pinned = first is not None and first < start
        if pinned:
            content.extend(entries[first])
        left_out = start - (1 if pinned else 0)
        content.append(
            {
                "type": "text",
                "text": (
                    f"The person's first message is above. {left_out} other earlier messages in "
                    "this conversation are not shown: they were left out to fit the context window. "
                    "If you are asked about something that is not shown, say you can no longer see it."
                    if pinned
                    else f"Earlier messages in this conversation are not shown: the {start} oldest "
                    "were left out to fit the context window. If you are asked about something "
                    "that is not below, say you can no longer see it."
                ),
            }
        )
    for blocks in entries[start:]:
        content.extend(blocks)
    if _read_as_a_command(content[-1]):
        content.append({"type": "text", "text": HISTORY_ENDS})
    return content


# Closes a replay that would otherwise end on a block Claude Code takes for a command.
HISTORY_ENDS = "That is the end of the conversation history."


def _read_as_a_command(block):
    """Whether Claude Code would take this block, last in its prompt, for one of its own commands.

    Claude Code reads the last text block of the prompt it is sent as what was typed at its prompt,
    and one that starts with `/` as a slash command of its own. It holds none of a skill's name, so
    it answered "Unknown command: /tide-report" itself and never asked the model. A message that
    arrives as parts (the server's model endpoint sent every user message that way) puts each part
    in a block of its own, so the person's words were that last block whenever they started with
    the command the `/` menu put there. Leading
    whitespace is counted too, in case a later Claude Code trims it before it looks.
    """
    return block["type"] == "text" and block["text"].lstrip().startswith("/")


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


def _first_request(messages):
    """Where the person's first message is: the request a long task is carried out under."""
    return next(
        (index for index, message in enumerate(messages) if message.role == "user"), None
    )


def _latest_request(messages):
    users = [index for index, message in enumerate(messages) if message.role == "user"]
    return users[-1] if users else len(messages)


def fit_to_budget(messages, entries, budget=None, current_turn=False):
    """The replay's entries, with the results of earlier turns' tool calls cut to fit `budget`.

    A tool result is the largest thing in a thread by far: a page of email, an app's tool list, a
    report. A few of them put a thread over the budget, and leaving out its oldest messages
    (`replay_start`) left out the person's own request: the Bot said it could no longer see the
    task it was half-way through. So the results of earlier turns are cut first, oldest first
    and only as far as the budget needs, each to its first `OLD_RESULT_CHARS` characters and a
    line saying how much was left out. The current turn's results (from the latest user message
    on) are cut only with `current_turn`, after every earlier one: they are what the Bot is working
    from now, and are cut only when the model refused the turn as too long without it.
    """
    budget = REPLAY_BUDGET_TOKENS if budget is None else budget
    entries = list(entries)
    costs = [estimated_tokens(blocks) for blocks in entries]
    total = sum(costs)
    for index in range(len(messages) if current_turn else _latest_request(messages)):
        if total <= budget:
            break
        message = messages[index]
        if message.role != "tool" or not isinstance(message.content, str):
            continue
        if len(message.content) <= OLD_RESULT_CHARS:
            continue
        entries[index] = _entry_blocks(_cut_result(message, OLD_RESULT_CHARS), strict=False)
        cost = estimated_tokens(entries[index])
        total += cost - costs[index]
        costs[index] = cost
    return entries


def replay_start(messages, costs, budget=None, pinned=None):
    """Where the replay starts: the oldest message the newest messages that fit `budget` reach.

    Everything from the latest user message on is always kept, whatever it costs: it is what this
    run answers, and any tool calls and results this turn has made since are part of it. The start
    never falls between a tool call and its result, or on a result, so no call is replayed without
    its answer and no answer without its call.

    `pinned` is the index of a message replayed whatever the start is, the person's first one
    (see `conversation_content`), so its cost comes out of the budget first.
    """
    budget = REPLAY_BUDGET_TOKENS if budget is None else budget
    if sum(costs) <= budget:
        return 0
    if pinned is not None:
        budget -= costs[pinned]
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
    total = sum(cost for index, cost in enumerate(costs[start:], start) if index != pinned)
    for index in range(start - 1, -1, -1):
        total += 0 if index == pinned else costs[index]
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


def system_prompt_in_file(options):
    """Hand Claude Code its system prompt in a file, and return the file's path to remove later.

    The SDK otherwise passes it as one `--system-prompt` argument, and Linux refuses to start a
    process with any argument over 128 KiB (`MAX_ARG_STRLEN`): `[Errno 7] Argument list too long`.
    A full Bot's prompt is its standing role, a line naming every tool it is offered, and every
    context entry the run carries (the browser's generative UI schema and guidelines, personal
    memory, learned skills), so a Bot holding a few large apps crossed it and never started.
    `--system-prompt-file` replaces Claude Code's prompt exactly as `--system-prompt` does.

    A preset's `append` is left alone: this harness never sets one.
    """
    prompt = options.system_prompt
    if not isinstance(prompt, str) or not prompt:
        return None
    handle, path = tempfile.mkstemp(prefix="openbot-system-prompt-", suffix=".md")
    with os.fdopen(handle, "w", encoding="utf-8") as file:
        file.write(prompt)
    options.system_prompt = {"type": "file", "path": path}
    return path


# How long ending a query waits for Claude Code to take the interrupt. The SDK itself waits 60
# seconds for the answer, and a Claude Code blocked on a tool call may never give one.
INTERRUPT_SECONDS = 10
# How long `SessionWorker.stop` may take to close the query the SDK's way: stop its in-process MCP
# servers (5 seconds for a stuck tool), close Claude Code's stdin and give it 5 seconds to exit,
# then terminate it.
STOP_SECONDS = 20
# How long Claude Code is given to exit after SIGTERM before it is sent SIGKILL.
TERMINATE_SECONDS = 5

# The ends of queries still under way, held so none is collected before it finishes.
_ENDING = set()


def finish_regardless(coroutine):
    """Run `coroutine` to its end even if whoever awaits it is cancelled.

    Ending a query is a run of awaits (interrupt Claude Code, close the SDK client, wait for the
    process), and a cancellation that reaches any of them leaves Claude Code running. The SDK's
    own close says so: an asyncio cancellation that arrives while it closes skips its terminate and
    kill. The cancellations come from the run itself: a second stop, the person's next message, a
    request that closed (whose cleanup Starlette cancels again at every await). Awaited through
    this, the caller can still be cancelled; the work it started finishes anyway.
    """
    task = asyncio.ensure_future(coroutine)
    _ENDING.add(task)
    task.add_done_callback(_ended)
    return asyncio.shield(task)


def _ended(task):
    _ENDING.discard(task)
    if not task.cancelled() and task.exception() is not None:
        logger.error("Ending a Claude query failed", exc_info=task.exception())


def _cli_transport(worker):
    """The SDK transport that started this worker's Claude Code, while the worker holds it."""
    return getattr(getattr(worker, "_client", None), "_transport", None)


def _descendants(pid):
    """The process ids under `pid`: whatever Claude Code itself started."""
    children = {}
    try:
        if os.path.isdir("/proc"):
            for entry in os.listdir("/proc"):
                if not entry.isdigit():
                    continue
                with suppress(OSError, IndexError, ValueError):
                    with open(f"/proc/{entry}/stat", encoding="utf-8") as stat:
                        # The command name is in parentheses and may hold spaces; the parent follows it.
                        ppid = int(stat.read().rsplit(")", 1)[1].split()[1])
                    children.setdefault(ppid, []).append(int(entry))
        else:
            listing = subprocess.run(
                ["ps", "-A", "-o", "pid=", "-o", "ppid="],
                capture_output=True,
                text=True,
                timeout=5,
                check=True,
            ).stdout
            for line in listing.splitlines():
                child, parent = (int(field) for field in line.split())
                children.setdefault(parent, []).append(child)
    except (OSError, subprocess.SubprocessError, ValueError):
        return []
    found, pending = [], [pid]
    while pending:
        for child in children.get(pending.pop(), []):
            found.append(child)
            pending.append(child)
    return found


async def end_cli_process(process):
    """Make sure a query's Claude Code, and anything it started, is no longer running.

    The SDK's close does this itself when it is allowed to finish, and then leaves nothing here to
    do. When it was cut short, Claude Code is still running with its stdin open, waiting on a tool
    call or for its next message, and nothing else will ever end it.
    """
    if process is None or process.returncode is not None:
        return
    logger.warning("Claude Code outlived its query's close; ending it (pid %s)", process.pid)
    descendants = await asyncio.to_thread(_descendants, process.pid)
    with suppress(ProcessLookupError):
        process.terminate()
    try:
        async with asyncio.timeout(TERMINATE_SECONDS):
            await process.wait()
    except TimeoutError:
        with suppress(ProcessLookupError):
            process.kill()
        with suppress(TimeoutError):
            async with asyncio.timeout(TERMINATE_SECONDS):
                await process.wait()
    for pid in descendants:
        with suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGKILL)
    # Its pipes, which the SDK keeps open for as long as it keeps the process.
    with suppress(Exception):
        async with asyncio.timeout(TERMINATE_SECONDS):
            await process.aclose()


async def end_query(adapter, worker, thread, run, turn, transport, prompt_file):
    """End one query: interrupt Claude Code, close its SDK client, and make sure it has exited.

    Runs through `finish_regardless`, so a cancellation of the run that started it cannot cut it
    short. Each SDK step is bounded, and whatever they leave running is ended here.
    """
    transport = _cli_transport(worker) or transport
    try:
        # Stop the CLI before cancelling any unresolved PostToolUse hooks; no placeholder result
        # may reach Claude.
        with suppress(TimeoutError):
            async with asyncio.timeout(INTERRUPT_SECONDS):
                await worker.interrupt()
        if turn:
            for result in turn.results.values():
                if not result.done():
                    result.cancel()
        # Only this query's own entries: a newer query on the thread may already be running.
        if (adapter._workers.get(thread) or {}).get("worker") is worker:
            adapter._workers.pop(thread, None)
            adapter._per_thread_state.pop(thread, None)
        adapter._per_run_result.pop((thread, run), None)
        transport = _cli_transport(worker) or transport
        try:
            async with asyncio.timeout(STOP_SECONDS):
                await worker.stop()
        except TimeoutError:
            logger.warning("Claude Code's SDK client did not close within %ss", STOP_SECONDS)
    finally:
        try:
            await end_cli_process(getattr(transport, "_process", None))
        finally:
            if prompt_file:
                with suppress(FileNotFoundError):
                    os.unlink(prompt_file)


async def run_replayed_query(adapter, input_data, fit_results=False):
    thread, run = input_data.thread_id, input_data.run_id
    model_only = adapter._model_only
    # The model endpoint is stateless by contract; the full harness keeps AG-UI shared state.
    state = None if model_only else input_data.state
    timeout = adapter._query_timeout_seconds or (
        MODEL_QUERY_TIMEOUT_SECONDS if model_only else None
    )
    # A fresh worker receives the current Bot instructions and granted schemas.
    # Tool-boundary HTTP continuations consume this still-running query instead
    # of creating a second worker or changing its identity, unless the model
    # endpoint sends them other tools than this query holds (see `adapter.run`).
    options = adapter.build_options(input_data, thread)
    prompt_file = system_prompt_in_file(options)
    worker = SessionWorker(thread, options)
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
                    input_data.messages, model_only=model_only, fit_results=fit_results
                ),
            },
            "parent_tool_use_id": None,
        }

    # Read again as the query ends; kept from its first message in case the worker has let go.
    transport = None

    try:
        await worker.start()
        if state is not None:
            yield StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=state)
        # A bound on a query that has stopped moving, not on how long it works: each message from
        # Claude Code pushes the deadline back. Counted from the start, it cut off a Bot that was
        # still working (nine browser steps took it past five minutes) with an error the person
        # never saw. Waiting on a client tool or the person brings no messages, so that wait still
        # ends here, before the PostToolUse hook's own timeout could hand Claude a placeholder.
        async with asyncio.timeout(timeout) as deadline:

            async def moving(messages):
                nonlocal transport
                async for message in messages:
                    transport = transport or _cli_transport(worker)
                    if timeout is not None:
                        deadline.reschedule(asyncio.get_running_loop().time() + timeout)
                    yield message

            async for event in adapter._stream_claude_sdk(
                moving(worker.query(prompt(), session_id=thread)),
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
        # Also runs on HTTP cancellation, and may itself be cancelled again: the query is ended in a
        # task of its own, which finishes whatever happens to this one (see `finish_regardless`).
        await finish_regardless(
            end_query(
                adapter,
                worker,
                thread,
                run,
                adapter._turns.get(thread),
                transport or _cli_transport(worker),
                prompt_file,
            )
        )
