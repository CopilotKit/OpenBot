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
