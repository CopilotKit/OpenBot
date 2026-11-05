"""The Bot's role, from the run the server sent, as the system prompt of that run.

The server sends the standing role and the granted-tools summary as `role: "system"` messages
at the head of `messages` on every run (`runWith` in `server/src/copilot.ts`). `ag_ui_strands`
has no branch for that role: its history builder and its messages snapshot both skip it, and the
per-thread agent it caches is built once with the template's system prompt. So a Bot on Strands
never saw its role, and a prompt set on the first run of a thread would be the prompt of every
later run, though the summary changes whenever a grant does.

Two seams the library supports carry it instead. `invocation_state(request, input_data)` is the
endpoint's `invocation_state_provider`: it reads the system and developer messages from this run,
in order. `RunSystemPrompt` is a Strands hook on `BeforeInvocationEvent`, which every per-thread
agent receives: it sets that agent's system prompt from the run's invocation state before the
first model call, so nothing from an earlier run remains. The messages stay out of the replayed
history, where the library already leaves them.
"""

from typing import Any

from strands.hooks import BeforeInvocationEvent

# Keys of the invocation state are stripped from every RAW event the library forwards, so the
# prompt does not reach the browser by this route.
KEY = "openbot_system_prompt"


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            text
            for part in content
            if isinstance(text := (part.get("text") if isinstance(part, dict) else getattr(part, "text", None)), str)
        )
    return ""


def system_text(messages: Any) -> list[str]:
    """The text of each system or developer message, in the order the run sent them."""
    found = []
    for message in messages or []:
        if getattr(message, "role", None) in ("system", "developer"):
            text = _text(getattr(message, "content", None)).strip()
            if text:
                found.append(text)
    return found


def invocation_state(_request: Any, input_data: Any) -> dict[str, Any]:
    return {KEY: system_text(getattr(input_data, "messages", None))}


class RunSystemPrompt:
    """Sets each invocation's system prompt: the base instruction, then this run's messages."""

    def __init__(self, base: str | None = None):
        self.base = (base or "").strip()

    def register_hooks(self, registry: Any, **_kwargs: Any) -> None:
        registry.add_callback(BeforeInvocationEvent, self._before_invocation)

    def _before_invocation(self, event: BeforeInvocationEvent) -> None:
        parts = [self.base] if self.base else []
        parts.extend((event.invocation_state or {}).get(KEY) or [])
        event.agent.system_prompt = "\n\n".join(parts) or None
