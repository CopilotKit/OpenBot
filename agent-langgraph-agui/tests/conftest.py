"""Make harness imports independent of pytest's working directory and test order."""

import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def _no_real_chatgpt_backend(monkeypatch):
    """No test reaches chatgpt.com, and no test sees another's ChatGPT plan listing.

    A test with a ChatGPT store reads the plan's model listing before it answers. One that serves
    a fake Codex backend (`test_model_choice.CodexBackend`) answers it; any other is refused here,
    which the harness treats as a listing it cannot read.
    """
    from src import chatgpt_models

    chatgpt_models.PLAN_MODELS.clear()
    send = httpx.AsyncClient.send

    async def refuse_chatgpt(self, request, **kwargs):
        if request.url.host == "chatgpt.com":
            raise httpx.ConnectError("chatgpt.com is not reachable from tests", request=request)
        return await send(self, request, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "send", refuse_chatgpt)
    yield
    chatgpt_models.PLAN_MODELS.clear()
