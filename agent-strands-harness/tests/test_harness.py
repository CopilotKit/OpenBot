"""What makes this Bot the harness, and what it leaves to OpenBot."""

import importlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import conversation, fake_provider, openai_environment

TOKEN = "contract-token"
HARNESS_VARIABLES = ("STRANDS_HARNESS_MODEL", "STRANDS_HARNESS_TOOLS", "STRANDS_HARNESS_INTERVENTIONS")


def _main(monkeypatch, base, **harness):
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    for key in HARNESS_VARIABLES:
        monkeypatch.delenv(key, raising=False)
    for key, value in {**openai_environment(base), **harness}.items():
        monkeypatch.setenv(key, value)
    sys.modules.pop("src.main", None)
    sys.modules.pop("src", None)
    return importlib.import_module("src.main")


def _run(main, thread="harness-thread"):
    response = TestClient(main.app).post(
        "/", json=conversation(thread), headers={"x-openbot-agent-token": TOKEN}
    )
    assert response.status_code == 200, response.text
    events = [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")]
    assert not [event for event in events if event["type"] == "RUN_ERROR"], events
    return events


def _offered(body: dict) -> list[str]:
    return sorted(tool["function"]["name"] for tool in body.get("tools") or [])


def test_health_names_the_harness(monkeypatch):
    with fake_provider() as (base, _bodies):
        main = _main(monkeypatch, base)
        assert TestClient(main.app).get("/health").json() == {"ok": True, "harness": "strands-harness"}


def test_each_conversation_gets_a_harness_of_its_own(monkeypatch):
    with fake_provider() as (base, _bodies):
        main = _main(monkeypatch, base)
        _run(main, "one")
        _run(main, "two")
    # The agent is closed over by its route, so it is found by its class.
    agents = [agent for bot in _bots(main) for agent in bot._agents_by_thread.values()]
    assert len(agents) == 2
    one, two = agents
    assert one is not two
    # What copying one agent would have lost, and what makes it the harness.
    assert one.context_manager is not None
    assert one.context_manager is not two.context_manager


def _bots(main):
    import gc

    return [obj for obj in gc.get_objects() if type(obj) is main.Bot]


def test_the_harness_contract_comes_before_the_role_openbot_sends(monkeypatch):
    from strands_harness import HARNESS_CONTRACT

    with fake_provider() as (base, bodies):
        _run(_main(monkeypatch, base))
    system = "\n".join(
        part.get("text", "") if isinstance(part, dict) else str(part)
        for message in bodies[-1]["messages"]
        if message["role"] == "system"
        for part in (message["content"] if isinstance(message["content"], list) else [message["content"]])
    )
    from harness_contract import STANDING_ROLE

    assert HARNESS_CONTRACT.splitlines()[0] in system
    assert system.index(HARNESS_CONTRACT.splitlines()[0]) < system.index(STANDING_ROLE)


def test_none_of_the_harness_tools_that_act_here_is_offered_by_default(monkeypatch):
    """They would run in this container, past the server's gateway."""
    with fake_provider() as (base, bodies):
        _run(_main(monkeypatch, base))
    acting = {"shell", "read", "write", "edit", "web_fetch", "web_search", "programmatic_tool_caller", "subagent"}
    assert not acting & set(_offered(bodies[-1]))


def test_what_openbot_keeps_is_not_kept_twice(monkeypatch, tmp_path):
    """No memory, skills or session files beside the process."""
    monkeypatch.chdir(tmp_path)
    with fake_provider() as (base, bodies):
        _run(_main(monkeypatch, base))
    assert not (tmp_path / ".agent").exists()
    assert "search_memory" not in _offered(bodies[-1])
    # Nor the harness's note about the machine it runs on: that is this container.
    assert "Working directory:" not in json.dumps(bodies[-1])


def test_a_deployment_can_switch_the_harness_tools_on(monkeypatch):
    with fake_provider() as (base, bodies):
        _run(_main(monkeypatch, base, STRANDS_HARNESS_TOOLS="shell, read"))
    assert {"shell", "read"} <= set(_offered(bodies[-1]))
    assert "write" not in _offered(bodies[-1])


@pytest.mark.parametrize("value,expected", [("", None), ("  ", None), ("ask", "ask")])
def test_interventions_come_from_the_environment(monkeypatch, value, expected):
    with fake_provider() as (base, _bodies):
        main = _main(monkeypatch, base, STRANDS_HARNESS_INTERVENTIONS=value)
    assert main.harness_options()["interventions"] == expected


def test_the_gate_is_kept_to_the_harnesss_tools(monkeypatch):
    """A tool OpenBot grants is run by the client, and the server already asks about it."""
    with fake_provider() as (base, _bodies):
        main = _main(monkeypatch, base, STRANDS_HARNESS_INTERVENTIONS="ask")
    (bot,) = [bot for bot in _bots(main) if bot._harness_options["interventions"] == "ask"]
    assert bot._gate_client_tools is False


def test_a_conversation_nobody_talks_in_is_let_go_and_comes_back_from_its_messages(monkeypatch):
    with fake_provider() as (base, _bodies):
        main = _main(monkeypatch, base)
        _run(main, "quiet")
        (bot,) = [bot for bot in _bots(main) if "quiet" in bot._agents_by_thread]
        assert bot.config.thread_idle_timeout == main.IDLE_SECONDS
        # As if the half hour had passed.
        bot._thread_last_run_ended["quiet"] -= main.IDLE_SECONDS
        _run(main, "busy")
        assert set(bot._agents_by_thread) == {"busy"}
        _run(main, "quiet")
        assert set(bot._agents_by_thread) == {"busy", "quiet"}


def test_stopping_the_process_shuts_every_conversations_harness_down(monkeypatch):
    with fake_provider() as (base, _bodies):
        main = _main(monkeypatch, base)
        with TestClient(main.app) as client:
            response = client.post("/", json=conversation("closing"), headers={"x-openbot-agent-token": TOKEN})
            assert response.status_code == 200, response.text
            (bot,) = [bot for bot in _bots(main) if "closing" in bot._agents_by_thread]
        assert bot._agents_by_thread == {}


def test_a_named_model_is_the_harnesss_to_reach(monkeypatch):
    """The AWS route: Bedrock with this process's credentials, not the server's gateway."""
    with fake_provider() as (base, _bodies):
        main = _main(monkeypatch, base)
        assert not isinstance(main.harness_options()["model"], str)
        monkeypatch.setenv("STRANDS_HARNESS_MODEL", "bedrock/global.anthropic.claude-opus-5-5")
        assert main.harness_options()["model"] == "bedrock/global.anthropic.claude-opus-5-5"
