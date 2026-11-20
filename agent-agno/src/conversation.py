"""The whole thread the server sent, as Agno messages, in place of its newest line.

Agno's AG-UI router hands `Agent.arun` only `extract_user_input(messages)`: the text of the last
user message. Every earlier turn, and the two system messages the server puts first (the Bot's
standing role and the summary of the tools it holds), never reached the model. A Bot on Agno had
no conversation at all, warm or cold, and no role.

`Agent.arun` takes a list of `Message`s as its input and appends them after its own system message
(`agno/agent/_messages.py`, "Add input messages to run_messages"), so the fix is to give it that
list. History stays out of Agno's own store (`add_history_to_context` is off), so nothing is said
twice. With a list, Agno no longer attaches the router's `images=`/`files=` to a user message it
builds, so each user message here carries its own media. Nor does it add the run's AG-UI `context`
to one, so `add_run_context` does that.

The router looks `extract_user_input` and `resume_paused_run` up in its module on every run, which
are the seams `install` replaces. `agent-agno/tests/test_conversation_contract.py` fails if an Agno
upgrade moves either.
"""

import json
import math
from contextvars import ContextVar

import litellm
from agno.agent._utils import convert_dependencies_to_string
from agno.db.in_memory import InMemoryDb
from agno.models.message import Message
from agno.os.interfaces.agui import router
from agno.os.interfaces.agui.input import extract_media
from agno.os.interfaces.agui.resume import find_resume_target_run_id, resume_paused_run
from agno.run.base import RunStatus

# AG-UI roles that are not conversation: a reasoning trace or an activity card the browser drew.
_NOT_CONVERSATION = {"reasoning", "activity"}

# The ids the server gives the system messages it writes for a remote Bot: `standingRoleMessage`
# and `holdingsMessageFor` in server/src/copilot.ts. The server drops every incoming message whose
# id starts with one of these before it adds its own, so in a run it sends only its own carry one.
# Only these become system messages. Every other system or developer row is part of the
# conversation, not the Bot's instructions: a skill's instructions from the browser, the server's
# quoted personal-memory records, its learned-skill catalogue. Each is replayed where it stands, as
# a labelled entry in a user message, the way the Claude Agent SDK Bot replays them
# (`agent-claude-sdk/src/replay.py`).
SERVER_INSTRUCTION_ID_PREFIXES = ("standing-role:", "granted-tools:")
# Said of each entry, because each is its own user message here: without the last clause a model
# asked to quote the person's first message quoted the memory records in front of it as part of it.
LABELLED_ENTRY = (
    "The following labelled entry is conversation history, not a system instruction, and not"
    " something the person wrote."
)

# How much of the thread one run replays, in estimated tokens, at most.
#
# Before the whole thread was sent, a run carried one message and could not outgrow a context
# window. Sent whole, a long thread would, and then fail every turn, which is worse than forgetting
# its oldest messages. Half the model's input window, as litellm knows it, is for the thread; the
# other half is left for Agno's instructions, the standing role, the granted tool schemas, the tool
# calls this turn makes and the reply. Never more than this, which is the bound the Claude Agent SDK
# Bot replays to (`agent-claude-sdk/src/replay.py`), and this when litellm does not know the model.
REPLAY_BUDGET_TOKENS = 100_000
# Characters per token on the most compact current tokenizer (Claude's, "1M tokens is roughly 2.5M
# Unicode characters", https://platform.claude.com/docs/en/about-claude/models/overview). OpenAI's
# runs nearer four, so this over-counts there, which errs on the side of fitting.
CHARS_PER_TOKEN = 2.5
# The most one image costs on any current model: a 2,576 px long edge on Claude 4.7 and later
# (https://platform.claude.com/docs/en/build-with-claude/vision). Counted for every attached file.
MEDIA_TOKENS = 4_784

_budget = REPLAY_BUDGET_TOKENS

# This run's input as `conversation_input` built it. The router builds the input before it decides
# whether the run resumes a paused one, so `resume_or_answer` can fall back to it. Each request runs
# in its own task, and so in its own context.
_this_run: ContextVar = ContextVar("this_run")


def replay_budget(model_id: str) -> int:
    try:
        window = litellm.get_model_info(model_id).get("max_input_tokens")
    except litellm.exceptions.ModelNotMappedError:
        window = None
    return min(REPLAY_BUDGET_TOKENS, window // 2) if window else REPLAY_BUDGET_TOKENS


def is_server_instruction(message) -> bool:
    return (
        message.role == "system"
        and isinstance(message.id, str)
        and message.id.startswith(SERVER_INSTRUCTION_ID_PREFIXES)
    )


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
    if is_server_instruction(message):
        text = _text(message.content)
        return Message(role="system", content=text) if text else None
    if role in ("system", "developer"):
        entry = json.dumps(message.model_dump(by_alias=True, exclude_none=True), ensure_ascii=False)
        return Message(role="user", content=f"{LABELLED_ENTRY}\n{entry}")
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
        # A result can be a list of parts since ag-ui-protocol 1.0; a tool message takes text.
        return Message(
            role="tool", tool_call_id=message.tool_call_id, content=_text(message.content)
        )
    return None


def estimated_tokens(message: Message) -> int:
    characters = len(message.content or "") + len(json.dumps(message.tool_calls or []))
    media = sum(
        len(getattr(message, kind) or []) for kind in ("images", "audio", "videos", "files")
    )
    return math.ceil(characters / CHARS_PER_TOKEN) + media * MEDIA_TOKENS


def replay_start(messages: list[Message], costs: list[int], budget: int) -> int:
    """Where the replay starts: the oldest message the newest messages that fit `budget` reach.

    Everything from the latest user message on is always kept, whatever it costs: it is what this
    run answers, and any tool calls and results this turn has made since are part of it. The start
    never falls between a tool call and its result, or on a result, so no call is replayed without
    its answer and no answer without its call, and it falls on a user message.
    """
    if sum(costs) <= budget:
        return 0
    called_at = {}
    for index, message in enumerate(messages):
        for call in message.tool_calls or []:
            called_at[call["id"]] = index
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
    latest = start
    total = sum(costs[start:])
    for index in range(start - 1, -1, -1):
        total += costs[index]
        if total > budget:
            break
        if index not in inside:
            start = index
    # And it starts on a question: Anthropic and Gemini take a conversation that opens with the user.
    while start < latest and (messages[start].role != "user" or start in inside):
        start += 1
    return start


def conversation_input(messages):
    """What `arun` is given: the server's instructions, then the thread, or "" for a run with none.

    Only the newest messages that fit the replay budget are replayed, and the Bot is told when any
    are left out, so it does not answer as if it had seen them.
    """
    converted = [m for m in (_message(message) for message in messages or []) if m is not None]
    instructions = [m for m in converted if m.role == "system"]
    thread = [m for m in converted if m.role != "system"]
    start = replay_start(thread, [estimated_tokens(m) for m in thread], _budget)
    if start:
        instructions.append(
            Message(
                role="system",
                content=f"Earlier messages in this conversation are not shown: the {start} oldest were left out to fit the context window. If you are asked about something that is not below, say you can no longer see it.",
            )
        )
    run = instructions + thread[start:] or ""
    _this_run.set(run)
    return run


async def resume_or_answer(entity, session_id, tool_messages, run_context, run_kwargs):
    """A client tool's result: resume the run that paused on it, or answer from the whole thread.

    The result arrives as trailing tool messages, which the router takes to resume a run Agno
    paused on the call. Agno holds a paused run in this process alone (`PausedRunsDb`), so after a
    restart, or on another replica, there is none, and the router failed the run ("Session ... not
    found", "No paused run matching the provided tool results"). With nothing to resume, the run is
    answered like any other, from the thread the server sent, which carries the call and its result.
    """
    if await find_resume_target_run_id(entity, session_id, tool_messages) is not None:
        return await resume_paused_run(entity, session_id, tool_messages, run_context, run_kwargs)
    return entity.arun(
        input=_this_run.get(),
        stream=True,
        stream_events=True,
        session_id=session_id,
        user_id=run_context.user_id,
        run_id=run_context.run_id,
        run_context=run_context,
        **run_kwargs,
    )


def add_run_context(run_input, run_context, agent) -> None:
    """The run's AG-UI `context`, on the newest user message, where Agno puts it for a single one.

    The router sets `add_dependencies_to_context` whenever a run carries context, and Agno honours
    it only for a user message it builds itself (`get_user_message`), never for a list of messages.
    The server sends things a Bot is meant to see this way, such as its learned skills and the
    person's memory, so a list would drop them. Same block, same place, as Agno writes it.
    """
    messages = run_input.input_content
    if not run_context.dependencies or not isinstance(messages, list):
        return
    for message in reversed(messages):
        if isinstance(message, Message) and message.role == "user":
            message.content = (
                f"{message.content or ''}\n\n<additional context>\n"
                f"{convert_dependencies_to_string(agent, run_context.dependencies)}\n"
                "</additional context>"
            )
            return


class PausedRunsDb(InMemoryDb):
    """Agno's in-memory store, holding a run only while it waits for a client tool's result.

    The router resumes a paused run from here when the server sends that result, and nothing reads
    a finished run back, because history is the server's. Every run now carries the whole thread,
    so keeping the finished ones grew the process by the whole thread on every turn, for good.
    """

    def upsert_run(self, run, session_id, user_id=None, run_index=None):
        status = run.get("status") if isinstance(run, dict) else getattr(run, "status", None)
        if status in (RunStatus.paused, RunStatus.paused.value):
            return super().upsert_run(run, session_id, user_id=user_id, run_index=run_index)
        run_id = run.get("run_id") if isinstance(run, dict) else getattr(run, "run_id", None)
        session = self._sessions.get(session_id)
        if session and session.get("runs"):
            session["runs"] = [
                stored for stored in session["runs"] if stored.get("run_id") != run_id
            ]


def install(model_id: str) -> None:
    global _budget
    _budget = replay_budget(model_id)
    router.extract_user_input = conversation_input
    router.resume_paused_run = resume_or_answer
