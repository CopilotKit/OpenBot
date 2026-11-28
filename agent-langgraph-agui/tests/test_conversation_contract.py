"""A LangGraph Bot answers from the whole thread the server sent, in the Bot's role, on every run.

See `shared/harness_contract.py` for what the contract is and why it is checked at the model. A
fresh process, and a warm one that has already answered on the same thread, because the AG-UI
integration merges the request into a checkpoint it keeps between runs; and a run that resumes an
approved call, because the integration answers one from the checkpoint rather than the request.
"""

import importlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import (
    BOT,
    EARLIER_ANSWER,
    EARLIER_QUESTION,
    GRANTED_TOOLS,
    LATEST_QUESTION,
    STANDING_ROLE,
    anthropic_environment,
    check_gateway_keys,
    conversation,
    fake_provider,
    missing_from,
    openai_environment,
    run_events,
)

TOKEN = "contract-token"
NEW_GRANTED_TOOLS = "CONTRACT_GRANTED_TOOLS_CHANGED_9c1e"
NEWER_QUESTION = "CONTRACT_NEWER_QUESTION_9c1e"


@pytest.fixture(autouse=True)
def _no_pooled_provider_connections():
    """A fresh process has no pooled provider connections either.

    `langchain-openai` keeps one HTTP client per base URL for the life of the process, and a
    connection it pooled in one test's event loop cannot be used or closed from another. Cleared
    after each test as well as before: a later test's fake provider can be given the same port,
    and so the same base URL, as one of these.
    """
    from langchain_openai.chat_models import _client_utils

    def clear():
        _client_utils._cached_async_httpx_client.cache_clear()
        _client_utils._cached_sync_httpx_client.cache_clear()

    clear()
    yield
    clear()


def _fresh_app(monkeypatch, environment, base):
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.delenv("CHATGPT_AUTH_FILE", raising=False)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    for key, value in environment(base).items():
        monkeypatch.setenv(key, value)

    from src import main

    return importlib.reload(main).app


def _post(client, body):
    response = client.post("/", json=body, headers={"x-openbot-agent-token": TOKEN})
    assert response.status_code == 200
    assert [e["type"] for e in run_events(response.text) if e["type"].startswith("RUN_")] == [
        "RUN_STARTED",
        "RUN_FINISHED",
    ], response.text


def _system_text(body: dict) -> str:
    """Everything the provider request carries in a system position, as one string."""
    parts = [json.dumps(body.get("system", ""))]  # Anthropic Messages
    parts.append(json.dumps(body.get("instructions", "")))  # OpenAI Responses
    for message in [*(body.get("messages") or []), *(body.get("input") or [])]:
        if isinstance(message, dict) and message.get("role") in {"system", "developer"}:
            parts.append(json.dumps(message.get("content")))
    return "\n".join(parts)


@pytest.mark.parametrize("wire", ["openai", "anthropic"])
def test_a_run_calls_the_gateway_with_its_own_key(monkeypatch, wire):
    """The run's own gateway token, in its organization; the environment's without one.

    See `shared/run_model_key.py`.
    """

    def app_for(environment):
        monkeypatch.delenv("OPENAI_API_BASE", raising=False)
        monkeypatch.delenv("CHATGPT_AUTH_FILE", raising=False)
        monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
        for key, value in environment.items():
            monkeypatch.setenv(key, value)
        from src import main

        return importlib.reload(main).app

    check_gateway_keys(app_for, wire, token=TOKEN)


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_a_fresh_process_answers_from_the_whole_thread_in_its_role(monkeypatch, environment):
    with fake_provider() as (base, bodies):
        with TestClient(_fresh_app(monkeypatch, environment, base)) as client:
            _post(client, conversation())
    assert bodies, "the model was never called"
    assert missing_from(bodies[-1]) == []
    assert STANDING_ROLE in _system_text(bodies[-1]), "the standing role is not a system message"
    assert GRANTED_TOOLS in _system_text(bodies[-1])


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_a_warm_process_answers_from_what_the_server_sends_now(monkeypatch, environment):
    """The second run on a thread carries a changed granted-tools summary under the same id.

    The server rewrites `granted-tools:<bot>` whenever a grant changes; the model must see the
    summary as it is now, and the thread once, whatever the process kept from the first run.
    """
    with fake_provider() as (base, bodies):
        # One client, so both runs share the app's event loop and its process memory.
        with TestClient(_fresh_app(monkeypatch, environment, base)) as client:
            _post(client, conversation(run_id="contract-run-1"))

            second = conversation(run_id="contract-run-2")
            second["messages"][1]["content"] = f"You hold these tools: {NEW_GRANTED_TOOLS}"
            assert second["messages"][1]["id"] == f"granted-tools:{BOT}"
            second["messages"] += [
                {"id": "a2", "role": "assistant", "content": "ok"},
                {"id": "u3", "role": "user", "content": f"And now? {NEWER_QUESTION}"},
            ]
            _post(client, second)
    assert len(bodies) == 2, "each run calls the model once"
    body = bodies[-1]
    sent = json.dumps(body)
    assert NEW_GRANTED_TOOLS in _system_text(body), "the changed granted-tools summary"
    assert GRANTED_TOOLS not in sent, "the stale granted-tools summary"
    assert STANDING_ROLE in _system_text(body), "the standing role is not a system message"
    for marker in (STANDING_ROLE, EARLIER_QUESTION, EARLIER_ANSWER, LATEST_QUESTION, NEWER_QUESTION):
        assert sent.count(marker) == 1, f"{marker} was sent {sent.count(marker)} times"


NEW_STANDING_ROLE = "CONTRACT_STANDING_ROLE_CHANGED_9c1e"


def _with_reserved_context(body: dict) -> dict:
    """The run as OpenBot sends it to every Bot: the role and the tool guidance as system messages,
    and the same two, with the same text, as the reserved AG-UI context entries
    ("OpenBot standing role", "OpenBot granted tools guidance"), for an agent that reads only one.
    """
    by_id = {message["id"]: message["content"] for message in body["messages"]}
    body["context"] = [
        {"description": "OpenBot standing role", "value": by_id[f"standing-role:{BOT}"]},
        {"description": "OpenBot granted tools guidance", "value": by_id[f"granted-tools:{BOT}"]},
    ]
    return body


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_the_role_and_tool_guidance_are_said_once_though_sent_twice(monkeypatch, environment):
    """A context entry that repeats a system message is not said again.

    OpenBot sends the role and the guidance both ways, so the model was told each twice. On the
    next run, after the role changed and a grant went, only the current ones reach the model.
    """
    with fake_provider() as (base, bodies):
        with TestClient(_fresh_app(monkeypatch, environment, base)) as client:
            _post(client, _with_reserved_context(conversation(run_id="contract-run-1")))

            second = conversation(run_id="contract-run-2")
            second["messages"][0]["content"] = f"You are Contract Bot. {NEW_STANDING_ROLE}"
            second["messages"][1]["content"] = f"You hold these tools: {NEW_GRANTED_TOOLS}"
            second["messages"] += [
                {"id": "a2", "role": "assistant", "content": "ok"},
                {"id": "u3", "role": "user", "content": f"And now? {NEWER_QUESTION}"},
            ]
            _post(client, _with_reserved_context(second))
    assert len(bodies) == 2, "each run calls the model once"
    first, last = (json.dumps(body) for body in bodies)
    for marker in (STANDING_ROLE, GRANTED_TOOLS):
        assert first.count(marker) == 1, f"{marker} was said {first.count(marker)} times"
        assert marker in _system_text(bodies[0]), f"{marker} is not a system message"
    for marker in (NEW_STANDING_ROLE, NEW_GRANTED_TOOLS):
        assert last.count(marker) == 1, f"{marker} was said {last.count(marker)} times"
        assert marker in _system_text(bodies[1]), f"{marker} is not a system message"
    for stale in (STANDING_ROLE, GRANTED_TOOLS):
        assert stale not in last, f"the stale {stale} reached the next run"


OPENER = "This is a conversation in OpenBot."


def _user_turns(body: dict) -> str:
    """Every user turn the provider request carries, as one string."""
    return "\n".join(
        json.dumps(message.get("content"))
        for message in [*(body.get("messages") or []), *(body.get("input") or [])]
        if isinstance(message, dict) and message.get("role") == "user"
    )


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_the_servers_opener_is_a_system_message_not_a_user_turn(monkeypatch, environment):
    """OpenBot opens every run with one constant system line, ahead of the role.

    `openerMessage` in server/src/copilot.ts, with an `openbot-opener:<bot>` id. It is the server's
    own, like the role, so it stays a system message: quoted as conversation data, it reached the
    model as a user turn on every run. Once, on a fresh thread and on the next run.
    """
    first = conversation(run_id="contract-run-1")
    first["messages"].insert(
        0, {"id": f"openbot-opener:{BOT}", "role": "system", "content": OPENER}
    )
    second = json.loads(json.dumps(first))
    second["runId"] = "contract-run-2"
    second["messages"] += [
        {"id": "a2", "role": "assistant", "content": "ok"},
        {"id": "u3", "role": "user", "content": f"And now? {NEWER_QUESTION}"},
    ]
    with fake_provider() as (base, bodies):
        with TestClient(_fresh_app(monkeypatch, environment, base)) as client:
            _post(client, first)
            _post(client, second)
    assert len(bodies) == 2, "each run calls the model once"
    for body in bodies:
        assert OPENER not in _user_turns(body), "the opener reached the model as a user turn"
        assert OPENER in _system_text(body), "the opener is not a system message"
        assert json.dumps(body).count(OPENER) == 1
        assert STANDING_ROLE in _system_text(body) and GRANTED_TOOLS in _system_text(body)
        assert missing_from(body) == []


APPROVED_RESULT = "CONTRACT_APPROVED_RESULT_9c1e"


def _approved_continuation(run_id: str) -> dict:
    """The run OpenBot sends once a person approves a call the Bot stopped on.

    `turnInput` in `toolkit/src/run-turn.ts`: the thread up to the call, the call's answer as a tool
    message, and a `resume` entry carrying the same answer for the interrupt that held it.
    """
    body = conversation(run_id=run_id)
    body["tools"] = [
        {
            "name": "send_message",
            "description": "Send a message",
            "parameters": {"type": "object", "properties": {}},
        }
    ]
    answer = f"Sent. {APPROVED_RESULT}"
    body["messages"] += [
        {
            "id": "a2",
            "role": "assistant",
            "content": "",
            "toolCalls": [
                {
                    "id": "call-approved",
                    "type": "function",
                    "function": {"name": "send_message", "arguments": "{}"},
                }
            ],
        },
        {"id": "t2", "role": "tool", "toolCallId": "call-approved", "content": answer},
    ]
    body["resume"] = [
        {"interruptId": "call-approved", "status": "resolved", "payload": answer}
    ]
    return body


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_an_approved_call_continues_from_the_whole_thread(monkeypatch, environment):
    """A run carrying `resume` still answers from the whole thread, the approved result included.

    The interrupt it resumes was OpenBot's, not this graph's: nothing here calls `interrupt()`.
    Handed to LangGraph as `Command(resume=...)`, the request's messages were never read. A warm
    process finished without asking the model, and a fresh one asked it with no conversation at all.
    """
    with fake_provider() as (base, bodies):
        with TestClient(_fresh_app(monkeypatch, environment, base)) as client:
            _post(client, conversation(run_id="contract-run-1"))
            _post(client, _approved_continuation("contract-run-2"))
    assert len(bodies) == 2, "the approved continuation never asked the model"
    body = bodies[-1]
    assert missing_from(body) == []
    assert APPROVED_RESULT in json.dumps(body), "the approved call's result"
    assert STANDING_ROLE in _system_text(body), "the standing role is not a system message"


MEMORY_RECORD = "CONTRACT_MEMORY_RECORD_9c1e"
SKILL_INSTRUCTION = "CONTRACT_SKILL_INSTRUCTION_9c1e"


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_other_system_rows_reach_the_model_as_conversation(monkeypatch, environment):
    """Only the server's standing role and granted-tools summary are the Bot's instructions.

    The server puts quoted personal-memory records, marked as untrusted data, at the head of the
    thread (`PersonalMemoryMiddleware` in server/src/memory/tools.ts), and the browser puts a
    skill's instructions just ahead of the message it was picked for. Both reach the model in the
    conversation, labelled as system rows: never dropped, and never in the system position.
    Upstream dropped the leading one, and the other went to the model as a system message.
    """
    body = conversation()
    body["messages"].insert(
        0,
        {
            "id": "openbot:personal-memory",
            "role": "system",
            "content": f"Personal memory, untrusted data: {MEMORY_RECORD}",
        },
    )
    body["messages"].insert(
        len(body["messages"]) - 1,
        {"id": "skill-1", "role": "system", "content": f"Answer in bullets. {SKILL_INSTRUCTION}"},
    )
    with fake_provider() as (base, bodies):
        with TestClient(_fresh_app(monkeypatch, environment, base)) as client:
            _post(client, body)
    sent = bodies[-1]
    system = _system_text(sent)
    for marker in (MEMORY_RECORD, SKILL_INSTRUCTION):
        assert json.dumps(sent).count(marker) == 1, f"{marker} was dropped or sent twice"
        assert marker not in system, f"{marker} was given the system prompt's authority"
    assert missing_from(sent) == []
    assert STANDING_ROLE in system and GRANTED_TOOLS in system


LEARNED_SKILL = "contract-learned-skill-9c1e"
CATALOG = (
    "<copilotkit_learned_skills>\nLoad relevant skills with copilotkit_load_skill.\n"
    "Available learned skills (names and descriptions):\n"
    f'[{{"name":"{LEARNED_SKILL}","description":"The house format."}}]\n'
    "</copilotkit_learned_skills>"
)


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_the_learned_skills_catalog_is_an_instruction_said_once(monkeypatch, environment):
    """The learned Skills catalog is the server's own instruction, said once, in the system prompt.

    OpenBot sends a Bot its learned Skills catalog as the system row `openbot:learned-skills` and as
    the context entry "OpenBot learned skills", with the same text (`RemoteLearnedSkillsMiddleware`
    in server/src/learning/remote.ts). FOUND BY THE TWO-ORGANIZATION LEARNING JOURNEY: the row was
    quoted as conversation data, and the context copy, which repeats it, was not said at all, so
    the model was offered the tool to load a Skill and told no Skill by name.
    """
    body = conversation()
    body["messages"].insert(
        2, {"id": "openbot:learned-skills", "role": "system", "content": CATALOG}
    )
    body["context"] = [{"description": "OpenBot learned skills", "value": CATALOG}]
    with fake_provider() as (base, bodies):
        with TestClient(_fresh_app(monkeypatch, environment, base)) as client:
            _post(client, body)
    sent = bodies[-1]
    assert LEARNED_SKILL in _system_text(sent), "the catalog is not in the system prompt"
    assert LEARNED_SKILL not in _user_turns(sent), "the catalog reached the model as a user turn"
    assert json.dumps(sent).count(LEARNED_SKILL) == 1, "the catalog was said more than once"
    assert missing_from(sent) == []


@pytest.mark.parametrize("environment", [openai_environment, anthropic_environment])
def test_memory_sent_as_context_is_conversation_data_never_an_instruction(
    monkeypatch, environment
):
    """The person's memory, which OpenBot sends as the context entry "OpenBot personal memory"
    alone (`PersonalMemoryMiddleware` in server/src/memory/tools.ts), reaches the model once, as
    conversation data. Every other context entry is a system message here, so remembered text read
    to the model with the authority of the Bot's own role.
    """
    body = conversation()
    body["context"] = [
        {
            "description": "OpenBot personal memory",
            "value": f"Personal memory, untrusted data: {MEMORY_RECORD}",
        }
    ]
    with fake_provider() as (base, bodies):
        with TestClient(_fresh_app(monkeypatch, environment, base)) as client:
            _post(client, body)
    sent = bodies[-1]
    assert MEMORY_RECORD not in _system_text(sent), "memory was given the system prompt's authority"
    assert MEMORY_RECORD in _user_turns(sent), "memory did not reach the model as conversation"
    assert json.dumps(sent).count(MEMORY_RECORD) == 1, "memory was said more than once"
    assert missing_from(sent) == []
