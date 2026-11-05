"""The whole thread the server sent, as Agno messages, in place of its newest line.

Agno's AG-UI router hands `Agent.arun` only `extract_user_input(messages)`: the text of the last
user message. Every earlier turn, and the two system messages the server puts first (the Bot's
standing role and the summary of the tools it holds), never reached the model. A Bot on Agno had
no conversation at all, warm or cold, and no role.

`Agent.arun` takes a list of `Message`s as its input and appends them after its own system message
(`agno/agent/_messages.py`, "Add input messages to run_messages"), so the fix is to give it that
list. History stays out of Agno's own store (`add_history_to_context` is off), so nothing is said
twice. With a list, Agno no longer attaches the router's `images=`/`files=` to a user message it
builds, so each user message here carries its own media.

The router looks `extract_user_input` up in its module on every run, which is the seam `install`
replaces. `agent-agno/tests/test_conversation_contract.py` fails if an Agno upgrade moves it.
"""

import json

from agno.models.message import Message
from agno.os.interfaces.agui import router
from agno.os.interfaces.agui.input import extract_media

# AG-UI roles that are not conversation: a reasoning trace or an activity card the browser drew.
_NOT_CONVERSATION = {"reasoning", "activity"}


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            part.text for part in content if getattr(part, "type", None) == "text" and part.text
        )
    return ""


def _message(message) -> Message | None:
    role = message.role
    if role in _NOT_CONVERSATION:
        return None
    if role in ("system", "developer"):
        text = _text(message.content)
        return Message(role="system", content=text) if text else None
    if role == "user":
        images, audio, videos, files = extract_media([message])
        return Message(
            role="user",
            content=_text(message.content),
            images=images or None,
            audio=audio or None,
            videos=videos or None,
            files=files or None,
        )
    if role == "assistant":
        calls = [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.function.name, "arguments": call.function.arguments},
            }
            for call in (getattr(message, "tool_calls", None) or [])
        ]
        return Message(
            role="assistant", content=_text(message.content) or None, tool_calls=calls or None
        )
    if role == "tool":
        content = message.content
        return Message(
            role="tool",
            tool_call_id=message.tool_call_id,
            content=content if isinstance(content, str) else json.dumps(content),
        )
    return None


def conversation_input(messages):
    """What `arun` is given: every turn of the thread, or "" for a run that carries none."""
    converted = [m for m in (_message(message) for message in messages or []) if m is not None]
    return converted or ""


def install() -> None:
    router.extract_user_input = conversation_input
