"""The spec file this Bot reads, and the one way it differs from every other Bot's row.

`shared/model-providers.json` is one file every language in the box reads. This is the row for
`agent-antigravity` — and unlike the rest, the provider is PINNED. Antigravity's bundled harness
requires a Gemini key wherever its base url points, so a deployment that moved its other Bots to
OpenAI must not drag this one along: it would start, accept work, and fail every call.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import BotSettings, bot_settings

BOT_ID = "agent-antigravity"
PINNED = "google"


def test_the_row_this_bot_runs(monkeypatch):
    monkeypatch.delenv("BOT_PROVIDER", raising=False)
    monkeypatch.delenv("BOT_MODEL", raising=False)
    assert bot_settings(BOT_ID, pinned_provider=PINNED) == BotSettings(
        provider="google", model="gemini-3.6-flash"
    )


def test_the_provider_is_pinned_against_a_deployment_that_moved_everything_else(monkeypatch):
    """BOT_PROVIDER wins everywhere else. Here it must not."""
    monkeypatch.setenv("BOT_PROVIDER", "openai")
    monkeypatch.delenv("BOT_MODEL", raising=False)
    assert bot_settings(BOT_ID, pinned_provider=PINNED).provider == "google"


def test_the_model_is_still_the_deployments_to_choose(monkeypatch):
    """Pinning the provider is not pinning the model: any Gemini the deployment names is fine."""
    monkeypatch.delenv("BOT_PROVIDER", raising=False)
    # Deliberately NOT the file's own model: an override that names what the row already says
    # would pass whether or not the environment was read at all.
    monkeypatch.setenv("BOT_MODEL", "gemini-3.8-flash")
    assert bot_settings(BOT_ID, pinned_provider=PINNED) == BotSettings(
        provider="google", model="gemini-3.8-flash"
    )


def test_this_bots_source_reads_the_spec_with_the_pin():
    source = (Path(__file__).resolve().parents[1] / "src" / "main.py").read_text(encoding="utf-8")
    assert 'bot_settings("agent-antigravity", pinned_provider="google")' in source


def test_the_key_and_base_url_come_from_the_provider_row():
    """Not hardcoded here.

    `shared/model-providers.json` names Google's key and base-url variables, and a Bot that
    spelled them out itself would drift from the file the moment either changed. The base-url
    variable is what points this Bot at a Gemini-compatible endpoint — a gateway, or aimock —
    instead of Google.
    """
    source = (Path(__file__).resolve().parents[1] / "src" / "main.py").read_text(encoding="utf-8")
    assert '"key_variable"' in source
    assert '"base_url_variable"' in source
    assert "GOOGLE_API_KEY" not in source
    assert "GOOGLE_GENERATIVE_AI_BASE_URL" not in source
