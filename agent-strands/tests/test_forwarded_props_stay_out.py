"""Nothing a run's sender adds to its forwarded props changes the tools a Strands Bot holds.

OpenBot's server passes a run's forwarded props on to the Bot as the browser sent them, less its own
`openbot*` keys. `ag_ui_strands` reads `injectA2UITool` from them: it adds a `generate_a2ui` tool
that calls the Bot's model again, and, given a tool's name, takes that tool away from the run. The
model must be offered the same tools with that prop as without it.

Through the production endpoint, at the model, with the fake provider every harness shares.
"""

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from harness_contract import conversation, fake_provider, openai_environment, run_events

TOKEN = "contract-token"
GRANTED = "web_lookup"


def _app(monkeypatch, base):
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", TOKEN)
    for key, value in openai_environment(base).items():
        monkeypatch.setenv(key, value)

    from src import main

    return importlib.reload(main).app


def offered(body):
    return sorted(
        tool.get("function", {}).get("name") or tool.get("name")
        for tool in body.get("tools") or []
    )


def tools_offered(monkeypatch, props, thread):
    with fake_provider() as (base, bodies):
        run = {
            **conversation(thread_id=thread, run_id=f"{thread}-1"),
            "tools": [
                {
                    "name": GRANTED,
                    "description": "Look something up",
                    "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
                }
            ],
            "forwardedProps": props,
        }
        with TestClient(_app(monkeypatch, base)) as client:
            response = client.post("/", json=run, headers={"x-openbot-agent-token": TOKEN})
        assert response.status_code == 200
        events = run_events(response.text)
        assert events[-1]["type"] == "RUN_FINISHED", events
        assert bodies, "the model was never called"
        return offered(bodies[0])


@pytest.mark.parametrize("inject", [True, GRANTED])
def test_the_sender_cannot_add_or_take_away_a_tool(monkeypatch, inject):
    plain = tools_offered(monkeypatch, {}, "props-plain")
    added = tools_offered(monkeypatch, {"injectA2UITool": inject}, f"props-{inject}")

    assert GRANTED in plain
    assert added == plain
