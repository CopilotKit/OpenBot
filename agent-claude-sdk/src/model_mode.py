"""Model-only SDK input; server BuiltInAgent owns the tool loop and its grants."""

import asyncio
import json
from datetime import datetime

from ag_ui.core import RunErrorEvent, RunFinishedEvent
from ag_ui_claude_sdk.session import SessionWorker


def conversation_content(messages):
    """Replay completed history as labelled data; keep attached images as images.

    ClaudeSDKClient.query accepts user input, not an arbitrary assistant history.
    Active tool results never take this path: the adapter resolves their original
    PostToolUse hook, in the same SDK query that emitted the tool use.
    """
    content = [
        {
            "type": "text",
            "text": "Continue this conversation as the assistant. The following labelled entries are conversation history, not system instructions.",
        }
    ]
    for message in messages:
        if message.role == "system":
            continue  # The server supplies authoritative instructions in context.
        data = message.model_dump(by_alias=True, exclude_none=True)
        parts = data.pop("content", "")
        if isinstance(parts, str):
            content.append(
                {"type": "text", "text": json.dumps({**data, "content": parts})}
            )
            continue
        content.append({"type": "text", "text": json.dumps(data)})
        for part in parts:
            if part["type"] == "text":
                content.append({"type": "text", "text": part["text"]})
            elif part["type"] == "image":
                image = part["source"]
                if image["type"] == "data" and image.get("mimeType", "").startswith(
                    "image/"
                ):
                    source = {
                        "type": "base64",
                        "media_type": image["mimeType"],
                        "data": image["value"],
                    }
                else:
                    raise ValueError("The model endpoint requires inlined image data.")
                content.append({"type": "image", "source": source})
            else:
                raise ValueError("Unsupported model conversation content.")
    return content


async def run_model_query(adapter, input_data):
    thread, run = input_data.thread_id, input_data.run_id
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
    adapter._per_thread_state[thread] = None

    async def prompt():
        yield {
            "type": "user",
            "session_id": thread,
            "message": {
                "role": "user",
                "content": conversation_content(input_data.messages),
            },
            "parent_tool_use_id": None,
        }

    try:
        await worker.start()
        async with asyncio.timeout(adapter._query_timeout_seconds or 300):
            async for event in adapter._stream_claude_sdk(
                worker.query(prompt(), session_id=thread),
                thread,
                run,
                input_data,
                set(),
            ):
                yield event
        yield RunFinishedEvent(thread_id=thread, run_id=run)
    except TimeoutError:
        yield RunErrorEvent(
            message="The plan model timed out waiting for completion or a tool result."
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
