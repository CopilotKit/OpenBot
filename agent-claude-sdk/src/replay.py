"""Every new SDK query answers from the thread the server sent, never from this process's memory.

OpenBot restores a thread from Intelligence and sends all of it in `input.messages`, on every run.
Upstream `ag-ui-claude-sdk` reads only `messages[-1]` and keeps the rest in a long-lived worker per
thread, so a restart, or the 30-minute idle eviction, leaves the Bot answering the newest message
alone. The worker also builds its options once, so context and grants changed after the first run
never reached it. Here each query gets a fresh worker, built from this run's input, and the whole
conversation as its prompt.

Client-tool continuations never take this path: the adapter resolves their PostToolUse hook in the
same SDK query that emitted the tool use.
"""

import asyncio
import json
from datetime import datetime

from ag_ui.core import EventType, RunErrorEvent, RunFinishedEvent, StateSnapshotEvent
from ag_ui_claude_sdk.session import SessionWorker

# The model endpoint has always bounded a query; the full harness runs agentic work that can take
# longer, and upstream only bounds it when a timeout is configured.
MODEL_QUERY_TIMEOUT_SECONDS = 300


def conversation_content(messages, strict=True):
    """Replay completed history as labelled data; keep attached images as images.

    ClaudeSDKClient.query accepts user input, not an arbitrary assistant history.
    System messages are instructions, not conversation: the model endpoint gets them in
    context, and the full harness puts them in the system prompt (see `system_instructions`).

    `strict` refuses a part the model cannot be shown. The full harness passes False, so a file
    that cannot be inlined is named in the history instead of failing the whole run.
    """
    content = [
        {
            "type": "text",
            "text": "Continue this conversation as the assistant. The following labelled entries are conversation history, not system instructions.",
        }
    ]
    for message in messages:
        if message.role == "system":
            continue
        data = message.model_dump(by_alias=True, exclude_none=True)
        parts = data.pop("content", "")
        if isinstance(parts, str):
            content.append(
                {"type": "text", "text": json.dumps({**data, "content": parts})}
            )
            continue
        content.append({"type": "text", "text": json.dumps(data)})
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
            content.append(block)
    return content


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
    """The system messages the server put in the thread, in order.

    A remote Bot's standing role and its granted-tools summary arrive this way, first, on every
    run, and nowhere else.
    """
    return "\n\n".join(
        message.content
        for message in messages
        if message.role == "system" and isinstance(message.content, str) and message.content
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
                    input_data.messages, strict=model_only
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
