"""The provider facts every Bot shares, read from `model-providers.json`.

The file beside this loader is the contract every language in the box reads: TypeScript reads it
through `shared/model-providers.ts`, this module reads it for the Python Bots, and any other
language reads it straight as JSON. A developer adding a Bot in Java adds one `bots` entry to the
file and never reads either loader.

ENVIRONMENT BEATS FILE, exactly as `docs/configuration.md` has always described: `BOT_PROVIDER`
and `BOT_MODEL` win, and the file supplies what they leave unset. API keys never appear in the
file — they arrive in the environment under the `key_variable` the provider row names.

A wrong or missing file stops the process at import with the path of the offending key, rather
than at the first model call: the mistakes this guards against are made in this repository, by a
hand editing the JSON, and the person who made it should meet it at startup.

The lookup here mirrors `botSettings` in `shared/model-providers.ts` line for line — same order,
same blank-is-unset reading, same refusal for a Bot with no row — because the two loaders answering
differently would put the languages of one box on different models, which is the drift this file
exists to end.

`PROVIDER_IDS` below is this module's copy of the list `shared/model-providers.ts` keeps for
itself, and each loader checks the file against its own list in both directions at import: a row
this module has never heard of, or a provider this module names that the file has no row for,
stops these Bots at startup rather than at their first model call. Adding a provider is one row in
the JSON file and one entry in each loader.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

_WHERE = "shared/model_providers.py"

# The providers this deployment knows the names of. The same list `shared/model-providers.ts`
# keeps for itself, written out here rather than read from the file: each loader checking the file
# against its own list is what makes a provider added to the JSON alone stop these Bots too, where
# before this list existed only the TypeScript Bots were stopped by it. Adding a provider is one
# entry here, one in that module, and one row to the JSON file.
PROVIDER_IDS: tuple[str, ...] = ("openai", "anthropic", "google")


def _spec_path() -> Path:
    """Where the file sits: beside this loader, unless the environment points elsewhere."""
    override = (os.environ.get("BOT_SPEC_PATH") or "").strip()
    if override:
        return Path(override)
    return Path(__file__).resolve().with_name("model-providers.json")


def _require_text(row: Any, field: str, where: str) -> str:
    value = row.get(field) if isinstance(row, dict) else None
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"shared/model-providers.json: {where} must be a non-empty string.")
    return value


def _load() -> dict[str, Any]:
    path = _spec_path()
    if not path.is_file():
        raise FileNotFoundError(
            f"shared/model-providers.json not found at {path}. The file sits beside this loader "
            "in shared/, or is named by BOT_SPEC_PATH; a Bot without it has no defaults to run."
        )
    try:
        spec = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"shared/model-providers.json at {path} is not JSON: {error}") from error
    if not isinstance(spec, dict):
        raise RuntimeError(f"shared/model-providers.json at {path} must hold an object.")

    providers = spec.get("providers")
    if not isinstance(providers, dict):
        raise RuntimeError("shared/model-providers.json: providers must be an object.")
    # The list's order rather than the file's, so the row an error names first is the row the list
    # named first — the same read the TypeScript loader makes.
    for provider_id in PROVIDER_IDS:
        row = providers.get(provider_id)
        if row is None:
            raise RuntimeError(
                f"shared/model-providers.json: providers is missing its {provider_id} row."
            )
        _require_text(row, "label", f"providers.{provider_id}.label")
        _require_text(row, "key_variable", f"providers.{provider_id}.key_variable")
        _require_text(row, "base_url_variable", f"providers.{provider_id}.base_url_variable")
        _require_text(row, "default_model", f"providers.{provider_id}.default_model")
    for provider_id in providers:
        if provider_id not in PROVIDER_IDS:
            raise RuntimeError(
                f"shared/model-providers.json: providers has a {provider_id} row this module "
                "has never heard of."
            )

    bots = spec.get("bots")
    if not isinstance(bots, dict):
        raise RuntimeError("shared/model-providers.json: bots must be an object.")
    for bot_id, entry in bots.items():
        if not isinstance(entry, dict):
            raise RuntimeError(f"shared/model-providers.json: bots.{bot_id} must be an object.")
        provider = _require_text(entry, "provider", f"bots.{bot_id}.provider")
        if provider not in PROVIDER_IDS:
            raise RuntimeError(
                f"shared/model-providers.json: bots.{bot_id}.provider is {json.dumps(provider)}, "
                f"not one of {', '.join(PROVIDER_IDS)}."
            )
        _require_text(entry, "model", f"bots.{bot_id}.model")

    return spec


SPEC: dict[str, Any] = _load()


@dataclass(frozen=True)
class BotSettings:
    """What one Bot was decided to run: its provider, and the model on it."""

    provider: str
    model: str


def default_model_for(provider: str) -> str:
    """A provider's default row, or OpenAI's for a name nobody has heard of."""
    row = SPEC["providers"].get(provider)
    if row is None:
        row = SPEC["providers"]["openai"]
    return row["default_model"]


def bot_settings(
    bot_id: str,
    env: Mapping[str, str] | None = None,
    pinned_provider: str | None = None,
) -> BotSettings:
    """This Bot's provider and model: environment over spec file over provider default.

    The lookup order is the whole contract, and it is the order `docs/configuration.md` already
    documents for `BOT_PROVIDER` and `BOT_MODEL` — the environment is how a deployment overrides
    what the repository decided, so it wins. What is new is the middle: the `bots` row this Bot
    had before, written down in one file every language reads instead of repeated in each Bot's
    source. A blank value is not a choice: compose hands `BOT_MODEL=` an empty string when nobody
    picked a model, and empty falls through to the file.

    A provider nobody has heard of is kept as typed, not rewritten to OpenAI, so the Bot's own
    refusal can put the name in its message. Its model falls back to the OpenAI default for the
    same reason the TypeScript loader does it: the refusal belongs to the Bot, one line below.

    A missing `bots` row throws rather than defaults. The file is in this repository; a Bot wired
    to it without a row is a mistake made while editing it, made at development time.
    """
    environ = os.environ if env is None else env

    entry = SPEC["bots"].get(bot_id)
    if entry is None:
        raise RuntimeError(
            f"shared/model-providers.json: bots has no {bot_id} entry. "
            "Add one before this Bot reads the spec file."
        )

    provider = (
        (pinned_provider or "").strip()
        or (environ.get("BOT_PROVIDER") or "").strip().lower()
        or entry["provider"]
    )

    # A model the environment names goes to whatever provider was resolved, because an endpoint
    # names its own catalogue. The file's model belongs to the file's provider, so a deployment
    # that moved this Bot to another provider gets that provider's default instead of a model
    # paired with the one it left.
    model = (environ.get("BOT_MODEL") or "").strip()
    if not model:
        model = (
            entry["model"] if provider == entry["provider"] else default_model_for(provider)
        )

    return BotSettings(provider=provider, model=model)
