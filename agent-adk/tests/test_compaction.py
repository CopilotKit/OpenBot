"""A long task keeps room in the conversation: ADK compacts the session's old events.

The session keeps the whole history between runs, and `ag_ui_adk` sends the model that history
plus only what it has not seen, so the thread OpenBot sends, old tool results cleared, never
reaches a live session. ADK's own events compaction keeps it inside the window instead. These are
the real objects a run is made of, built the way the library builds them for every request.
"""

import asyncio
import importlib
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _main(monkeypatch):
    for name, value in {
        "OPENAI_API_KEY": "synthetic-test-key",
        "OPENAI_BASE_URL": "http://127.0.0.1:9/v1",
        "BOT_PROVIDER": "openai",
        "BOT_MODEL": "gpt-4.1-mini",
        "MANAGED_AGENT_TOKEN": "compaction-token",
        "OTEL_SDK_DISABLED": "true",
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    from src import main

    return importlib.reload(main)


def test_every_runs_invocation_compacts_past_the_token_threshold(monkeypatch):
    main = _main(monkeypatch)
    agent = main.agent
    # Still the subclass that keeps a session to the thread the server sends.
    assert isinstance(agent, main.WholeThreadADKAgent)

    # The runner the library builds for a request, with the agent as that request changed it.
    runner = agent._create_runner(agent._adk_agent, "openbot", "openbot")
    config = runner.app.events_compaction_config
    assert config is not None
    assert config.token_threshold == 100_000
    assert config.event_retention_size == 20

    async def invocation():
        session = await runner.session_service.create_session(
            app_name="openbot", user_id="openbot", session_id="thread-compaction"
        )
        return runner._new_invocation_context(session)

    context = asyncio.run(invocation())
    assert context.events_compaction_config is config, "each invocation is given it"
