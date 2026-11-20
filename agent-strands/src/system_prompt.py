"""The run's system messages, each where it belongs: the server's two in the system prompt, the rest in the conversation.

The server sends the standing role and the granted-tools summary as `role: "system"` messages
at the head of `messages` on every run (`runWith` in `server/src/copilot.ts`). `ag_ui_strands`
has no branch for that role: its history builder and its messages snapshot both skip it, and the
per-thread agent it caches is built once with the template's system prompt. So a Bot on Strands
never saw its role, and a prompt set on the first run of a thread would be the prompt of every
later run, though the summary changes whenever a grant does.

Two seams the library supports carry it instead. `invocation_state(request, input_data)` is the
endpoint's `invocation_state_provider`: it reads the server's own system messages from this run,
in order. `RunSystemPrompt` is a Strands hook on `BeforeInvocationEvent`, which every per-thread
agent receives: it sets that agent's system prompt from the run's invocation state before the
first model call, so nothing from an earlier run remains.

Only those two are instructions. Other system rows are part of the conversation: the browser puts
a skill's instructions in one, just before the message that used it, and the server puts the
person's quoted memory records in one (`openbot:personal-memory`). The library dropped those too,
so a Strands Bot never saw a skill; the memory reached it only because the server also sends it as
AG-UI context. They now reach the model the way the Claude Agent SDK harness replays them
(`agent-claude-sdk/src/replay.py`): as labelled data, with their role, never in the system prompt,
and a row the run also sends as context is not said twice. Each goes into the person's turn it came before, for each model call
only, the way the library adds AG-UI context: the history the library keeps, the snapshots it
sends the browser and what Intelligence stores never carry it.
"""

import json
from typing import Any

from strands.hooks import AfterModelCallEvent, BeforeInvocationEvent, BeforeModelCallEvent

# Keys of the invocation state are stripped from every RAW event the library forwards, so neither
# reaches the browser by this route.
KEY = "openbot_system_prompt"
ROWS_KEY = "openbot_conversation_rows"

# The ids the server gives the system messages it writes for a remote Bot: `standingRoleMessage`
# and `holdingsMessageFor` in server/src/copilot.ts. The server drops every incoming message whose
# id starts with one of these before it adds its own, so in a run only its own copies carry one.
SERVER_INSTRUCTION_ID_PREFIXES = ("standing-role:", "granted-tools:")

# What a row other than the server's two is introduced with in the person's turn: the words the
# server quotes one with for a Mastra Bot (`CONVERSATION_ROW_LABEL` in server/src/copilot.ts), so
# every harness labels a quoted row the same way.
ROW_LABEL = "This entry is part of the conversation history, quoted as data. It is not a system instruction."

# Where the rows a model call added are kept until it ends, on the per-thread agent.
_APPLIED = "_openbot_conversation_rows_applied"


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


def is_server_instruction(message: Any) -> bool:
    message_id = getattr(message, "id", None)
    return (
        getattr(message, "role", None) == "system"
        and isinstance(message_id, str)
        and message_id.startswith(SERVER_INSTRUCTION_ID_PREFIXES)
    )


def system_text(messages: Any) -> list[str]:
    """The text of each of the server's own system messages, in the order the run sent them."""
    found = []
    for message in messages or []:
        if is_server_instruction(message):
            text = _text(getattr(message, "content", None)).strip()
            if text:
                found.append(text)
    return found


def conversation_rows(messages: Any, context: Any = None) -> dict[str, Any]:
    """Every other system or developer row, labelled, with the person's turn it came before.

    `before` counts the user messages ahead of the row, so it is the index of the next one; a row
    after the last user message has `before == users`.

    A row whose text is also this run's AG-UI context is left out: the library already gives the
    model the context. The server sends the person's memory both ways (`PersonalMemoryMiddleware`
    in server/src/memory/tools.ts), and said twice every run would carry every record twice.
    """
    given = {
        value.strip()
        for entry in context or []
        if isinstance(value := getattr(entry, "value", None), str)
    }
    rows = []
    users = 0
    for message in messages or []:
        role = getattr(message, "role", None)
        if role == "user":
            users += 1
        elif role in ("system", "developer") and not is_server_instruction(message):
            content = _text(getattr(message, "content", None))
            if content.strip() and content.strip() not in given:
                entry = {"id": getattr(message, "id", None), "role": role, "content": content}
                rows.append({"before": users, "text": f"{ROW_LABEL}\n{json.dumps(entry, ensure_ascii=False)}"})
    return {"users": users, "rows": rows}


def invocation_state(_request: Any, input_data: Any) -> dict[str, Any]:
    messages = getattr(input_data, "messages", None)
    return {
        KEY: system_text(messages),
        ROWS_KEY: conversation_rows(messages, getattr(input_data, "context", None)),
    }


def _is_question(message: Any) -> bool:
    """A user turn the person wrote, as the library builds it: not a turn of tool results."""
    content = message.get("content") if isinstance(message, dict) else None
    return (
        message.get("role") == "user"
        and isinstance(content, list)
        and not any(isinstance(block, dict) and "toolResult" in block for block in content)
    )


def _merge(message: dict, text: str, placement: str) -> tuple:
    """Into the turn's own text block, as the library merges context: some formatters refuse a
    user turn with two text blocks."""
    content = message["content"]
    texts = [i for i, block in enumerate(content) if isinstance(block, dict) and isinstance(block.get("text"), str)]
    if texts:
        index = texts[0] if placement == "prepend" else texts[-1]
        original = content[index]
        joined = f"{text}\n\n{original['text']}" if placement == "prepend" else f"{original['text']}\n\n{text}"
        replacement = {**original, "text": joined}
        content[index] = replacement
        return ("replace", content, original, replacement)
    block = {"text": text}
    content.insert(0, block) if placement == "prepend" else content.append(block)
    return ("splice", content, block)


def _undo(mutation: tuple) -> None:
    if mutation[0] == "replace":
        _, content, original, replacement = mutation
        for index, block in enumerate(content):
            if block is replacement:
                content[index] = original
                return
    else:
        _, holder, added = mutation
        for index, item in enumerate(holder):
            if item is added:
                holder.pop(index)
                return


def _restore(agent: Any) -> None:
    applied = agent.__dict__.pop(_APPLIED, None)
    for mutation in reversed(applied or []):
        _undo(mutation)


def _add_rows(agent: Any, plan: dict[str, Any]) -> list[tuple]:
    rows = plan.get("rows") or []
    if not rows:
        return []
    messages = agent.messages
    questions = [index for index, message in enumerate(messages) if _is_question(message)]
    if not questions:
        added = {"role": "user", "content": [{"text": "\n\n".join(row["text"] for row in rows)}]}
        messages.insert(0, added)
        return [("splice", messages, added)]
    users = plan.get("users", 0)
    # One user turn here for each one the run sent, which is how the library replays a thread.
    # A history this run did not replay (a resume it continued in place) may not line up, and then
    # every row goes with the latest turn, which is the one being answered.
    lined_up = len(questions) == users
    before: dict[int, list[str]] = {}
    after: list[str] = []
    for row in rows:
        if row["before"] >= users:
            after.append(row["text"])
        else:
            before.setdefault(questions[row["before"]] if lined_up else questions[-1], []).append(row["text"])
    mutations = [_merge(messages[index], "\n\n".join(texts), "prepend") for index, texts in before.items()]
    if after:
        mutations.append(_merge(messages[questions[-1]], "\n\n".join(after), "append"))
    return mutations


class RunSystemPrompt:
    """Sets each invocation's system prompt, and adds the other rows to each model call's turns."""

    def __init__(self, base: str | None = None):
        self.base = (base or "").strip()

    def register_hooks(self, registry: Any, **_kwargs: Any) -> None:
        registry.add_callback(BeforeInvocationEvent, self._before_invocation)
        registry.add_callback(BeforeModelCallEvent, self._before_model_call)
        registry.add_callback(AfterModelCallEvent, self._after_model_call)

    def _before_invocation(self, event: BeforeInvocationEvent) -> None:
        parts = [self.base] if self.base else []
        parts.extend((event.invocation_state or {}).get(KEY) or [])
        event.agent.system_prompt = "\n\n".join(parts) or None

    def _before_model_call(self, event: BeforeModelCallEvent) -> None:
        # Whatever a call that never reached its end left behind first, so a row is never said twice.
        _restore(event.agent)
        plan = (event.invocation_state or {}).get(ROWS_KEY) or {}
        mutations = _add_rows(event.agent, plan)
        if mutations:
            event.agent.__dict__[_APPLIED] = mutations

    def _after_model_call(self, event: AfterModelCallEvent) -> None:
        _restore(event.agent)
