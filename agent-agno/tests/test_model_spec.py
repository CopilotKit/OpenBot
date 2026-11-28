"""The spec file this Bot reads, pinned to what this repository decided.

`shared/model-providers.json` is one file every language in the box reads; this test is the row
for `agent-agno` and the order the Python loader applies it in. If the file changes on purpose, this
test changes with it — the review point the file exists to create.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import BotSettings, bot_settings, litellm_model_id

BOT_ID = "agent-agno"


def test_the_row_this_bot_runs(monkeypatch):
    monkeypatch.delenv("BOT_PROVIDER", raising=False)
    monkeypatch.delenv("BOT_MODEL", raising=False)
    assert bot_settings(BOT_ID) == BotSettings(provider="openai", model="gpt-5.5")


def test_environment_beats_the_file(monkeypatch):
    monkeypatch.setenv("BOT_PROVIDER", "anthropic")
    monkeypatch.setenv("BOT_MODEL", "claude-haiku")
    assert bot_settings(BOT_ID) == BotSettings(provider="anthropic", model="claude-haiku")


def test_blank_environment_falls_through_to_the_file(monkeypatch):
    monkeypatch.setenv("BOT_PROVIDER", "")
    monkeypatch.setenv("BOT_MODEL", "   ")
    assert bot_settings(BOT_ID) == BotSettings(provider="openai", model="gpt-5.5")


def test_litellm_calls_google_gemini():
    """litellm has no `google` provider; Google AI Studio is `gemini` there."""
    assert litellm_model_id("google", "gemini-2.5-flash") == "gemini/gemini-2.5-flash"
    assert litellm_model_id("openai", "qwen/qwen3-8b") == "openai/qwen/qwen3-8b"
    assert litellm_model_id("anthropic", "claude-haiku") == "anthropic/claude-haiku"
