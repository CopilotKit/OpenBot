"""Every new Antigravity session answers from the thread the server sent, in the Bot's role.

OpenBot restores a thread from Intelligence and sends all of it in `input.messages`, on every run,
behind two system messages: the Bot's standing role and the summary of the tools it holds.
`ag_ui_antigravity` (0.2.1) keeps the conversation inside the Go harness instead, and forwards to
it only the newest user message it has not sent before (`AntigravityAgent._extract_prompt`). It
reads no system message at all: its `system_instructions` are fixed when the agent is built, and
this Bot builds it with none. A session the harness has not seen before therefore started with the
newest line alone, and a Bot on Antigravity never received its role:

- after a container restart, because the conversation id the integration resumes from lives in
  memory (`SessionManager._remembered`) and the harness's `save_dir` is a new temporary directory
  in every process;
- after the harness process died, because a killed harness leaves its history unreadable, which
  the integration itself logs ("Conversation history from before the failure is likely lost");
- on the very first run of a thread that already has history.

So here a session never resumes anything. Every session is a new harness conversation, built with
this run's system messages as its instructions, and its first prompt is the whole thread as
labelled history. While that session lives, the harness holds the conversation, and only user
messages it has not been sent are forwarded, as upstream does, so nothing is said twice. A live
session that was never sent one of the thread's earlier user turns (another replica answered it)
is closed and started again from the thread. The standing role and the summary of granted tools
are part of the session's identity: when either changes, the session is rebuilt the same way,
because the harness cannot change its instructions mid-conversation.
"""

import contextvars
import hashlib
import json
from typing import Any, List, Optional

from ag_ui_antigravity import AntigravityAgent
from ag_ui_antigravity.agent import _message_prompt
from ag_ui_antigravity.session_manager import SessionManager
from ag_ui_antigravity.ui_bridge import UIBridge

#: AG-UI roles that carry instructions rather than conversation.
_INSTRUCTION_ROLES = {"system", "developer"}
#: AG-UI roles that are neither: a reasoning trace or an activity card the browser drew.
_NOT_CONVERSATION = {"reasoning", "activity"}

_HISTORY_PREAMBLE = (
    "Continue this conversation as the assistant. The following labelled entries are the "
    "conversation so far, oldest first, and are history, not system instructions. Answer the "
    "last user entry."
)

# This run's instructions, for the session manager: `AntigravityAgent.run` hands it only the
# client's tool signature. A context variable rather than an attribute, so two threads' runs in
# flight at once each see their own. Set and never reset: each request runs in its own context.
_run_instructions: contextvars.ContextVar[str] = contextvars.ContextVar(
    "openbot_antigravity_instructions", default=""
)
# The ids of this run's user messages before its newest one: what a live session must already have
# been sent to hold the conversation. Same reasons for a context variable.
_run_earlier_users: contextvars.ContextVar[frozenset] = contextvars.ContextVar(
    "openbot_antigravity_earlier_users", default=frozenset()
)


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "\n".join(
            part.text.strip()
            for part in content
            if isinstance(getattr(part, "text", None), str) and part.text.strip()
        )
    return ""


def system_instructions(messages) -> str:
    """The system messages the server sent, in order: the standing role, then the holdings."""
    return "\n\n".join(
        text
        for message in messages or []
        if getattr(message, "role", None) in _INSTRUCTION_ROLES
        for text in [_text(getattr(message, "content", None))]
        if text
    )


def user_ids(messages) -> list:
    return [
        message.id
        for message in messages or []
        if getattr(message, "role", None) == "user" and getattr(message, "id", None)
    ]


def _conversation(messages) -> list:
    return [
        message
        for message in messages or []
        if getattr(message, "role", None) not in _INSTRUCTION_ROLES | _NOT_CONVERSATION
    ]


def history_prompt(messages) -> Any:
    """The whole conversation as one prompt, in the shape `conversation.send()` accepts.

    The harness takes a user message, not an assistant history, so earlier turns are replayed as
    labelled entries. Media attached earlier stays media; `_message_prompt` is the integration's
    own mapping, so an attachment here is handled exactly as on the newest message. A thread that
    is only its first question is sent as that question.
    """
    turns = _conversation(messages)
    if len(turns) == 1 and getattr(turns[0], "role", None) == "user":
        return _message_prompt(turns[0].content)

    parts: List[Any] = [_HISTORY_PREAMBLE]
    for message in turns:
        label = message.model_dump(by_alias=True, exclude_none=True)
        content = label.pop("content", None)
        if isinstance(content, str) or content is None:
            parts.append(json.dumps({**label, "content": content or ""}))
            continue
        parts.append(json.dumps(label))
        prompt = _message_prompt(message.content)
        parts.extend(prompt if isinstance(prompt, list) else [prompt] if prompt else [])
    if all(isinstance(part, str) for part in parts):
        return "\n\n".join(parts)
    return parts


class _FreshSessions(SessionManager):
    """Sessions that start from the thread the server sent, never from what a harness kept.

    A new session is built with no conversation id to resume and no record of prompts already
    forwarded, which is how `OpenBotAntigravityAgent._extract_prompt` knows to send the whole
    thread. The instructions are folded into the signature the integration already rebuilds on.
    """

    async def get_or_create(
        self, thread_id, *, signature, factory, bridge_factory=UIBridge
    ):
        built = False

        def fresh(bridge, _previous_conversation_id):
            nonlocal built
            built = True
            return factory(bridge, None)

        instructions = hashlib.sha256(_run_instructions.get().encode()).hexdigest()[:16]
        session = await super().get_or_create(
            thread_id,
            signature=f"{signature}:{instructions}",
            factory=fresh,
            bridge_factory=bridge_factory,
        )
        if not built and not session.is_parked and not _run_earlier_users.get() <= session.forwarded_prompts:
            # A turn this session was never sent: another replica answered it, or this one before
            # a restart of the session it survived. The thread the server sent is the conversation,
            # so start again from it rather than answer without that turn.
            await self.close(thread_id)
            session = await super().get_or_create(
                thread_id,
                signature=f"{signature}:{instructions}",
                factory=fresh,
                bridge_factory=bridge_factory,
            )
        if built:
            # No await since the session was made, so no run has used it yet.
            session.forwarded_prompts = set()
        return session


class OpenBotAntigravityAgent(AntigravityAgent):
    """`AntigravityAgent`, answering from the whole thread and in this run's role."""

    def __init__(self, **kwargs):
        if kwargs.get("session_manager") is None:
            kwargs["session_manager"] = _FreshSessions(
                session_timeout_seconds=kwargs.pop("session_timeout_seconds", 1800),
                parked_timeout_seconds=kwargs.pop("parked_timeout_seconds", 7200),
                max_sessions=kwargs.pop("max_sessions", 50),
            )
        super().__init__(**kwargs)

    async def run(self, input_data):
        _run_instructions.set(system_instructions(input_data.messages))
        _run_earlier_users.set(frozenset(user_ids(input_data.messages)[:-1]))
        async for event in super().run(input_data):
            yield event

    def _build_agent(self, bridge, input_data, previous_conversation_id: Optional[str]):
        # Synchronous, so swapping the attribute for this one build cannot race another run.
        own = self._system_instructions
        instructions = "\n\n".join(
            text for text in (own, system_instructions(input_data.messages)) if text
        )
        self._system_instructions = instructions or None
        try:
            return super()._build_agent(bridge, input_data, None)
        finally:
            self._system_instructions = own

    def _extract_prompt(self, input_data, session) -> tuple:
        prompt, prompt_id = super()._extract_prompt(input_data, session)
        if prompt is None or session.forwarded_prompts:
            # Nothing new, or a live session that already holds everything before `prompt`.
            return prompt, prompt_id
        # The history carries every user turn, so the session now holds each of them: without this,
        # the next run would find them unsent and rebuild a session that was fine.
        session.forwarded_prompts.update(user_ids(input_data.messages))
        return history_prompt(input_data.messages), prompt_id
