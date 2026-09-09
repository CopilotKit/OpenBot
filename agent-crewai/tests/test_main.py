import sys
from copy import deepcopy
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import main


class FakeMessage:
    def model_dump(self):
        return {"role": "assistant", "content": "probe reply"}


class FakeChoice:
    message = FakeMessage()


class FakeCompletion:
    choices = [FakeChoice()]


def run_input(messages):
    return {
        "threadId": "thread-1",
        "runId": "run-1",
        "state": {},
        "messages": messages,
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def test_crewai_endpoint_preserves_leading_bot_role_for_provider(monkeypatch):
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "test-token")
    provider_messages = []

    async def record_completion(*, model, messages, stream):
        provider_messages.append(deepcopy(messages))
        return FakeCompletion()

    monkeypatch.setattr(main, "acompletion", record_completion)

    client = TestClient(main.app)
    response = client.post(
        "/",
        headers={"x-openbot-agent-token": "test-token"},
        json=run_input(
            [
                {
                    "id": "system-1",
                    "role": "system",
                    "content": "You are Ada, a Bot-specific finance analyst.",
                },
                {
                    "id": "user-1",
                    "role": "user",
                    "content": "What should I review first?",
                },
            ]
        ),
    )

    assert response.status_code == 200
    assert provider_messages == [
        [
            {
                "id": "system-1",
                "role": "system",
                "content": "You are Ada, a Bot-specific finance analyst.",
            },
            {
                "id": "user-1",
                "role": "user",
                "content": "What should I review first?",
            },
        ]
    ]
