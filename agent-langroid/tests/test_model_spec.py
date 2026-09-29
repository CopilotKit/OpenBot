"""The spec file this Bot reads, pinned to what this repository decided.

`shared/model-providers.json` is one file every language in the box reads; this test is the row
for `agent-langroid` and the order the Python loader applies it in. If the file changes on purpose, this
test changes with it — the review point the file exists to create.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import BotSettings, bot_settings

BOT_ID = "agent-langroid"


def test_the_row_this_bot_runs(monkeypatch):
    monkeypatch.delenv("BOT_PROVIDER", raising=False)
    monkeypatch.delenv("BOT_MODEL", raising=False)
    assert bot_settings(BOT_ID) == BotSettings(provider="openai", model="gpt-4o-mini")


def test_environment_beats_the_file(monkeypatch):
    monkeypatch.setenv("BOT_PROVIDER", "anthropic")
    monkeypatch.setenv("BOT_MODEL", "claude-haiku")
    assert bot_settings(BOT_ID) == BotSettings(provider="anthropic", model="claude-haiku")


def test_blank_environment_falls_through_to_the_file(monkeypatch):
    monkeypatch.setenv("BOT_PROVIDER", "")
    monkeypatch.setenv("BOT_MODEL", "   ")
    assert bot_settings(BOT_ID) == BotSettings(provider="openai", model="gpt-4o-mini")


def test_this_bots_source_reads_the_spec():
    source = (Path(__file__).resolve().parents[1] / "src" / "main.py").read_text(encoding="utf-8")
    assert f'bot_settings("agent-langroid")' in source
