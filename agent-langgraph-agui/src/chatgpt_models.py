"""The models a signed-in ChatGPT plan offers, read from the plan's own Codex listing.

A ChatGPT plan answers on `chatgpt.com/backend-api/codex`, and that backend refuses any model the
plan does not offer ("The 'gpt-5.5' model is not supported when using Codex with a ChatGPT
account."). Which models those are changes with the plan and over time, so they are read from the
same backend, with the same token and account, that the plan's answers come from: `GET /models`,
the listing the Codex CLI builds its own model picker from.

The shape is Codex's own (`ModelsResponse` and `ModelInfo` in openai/codex
`codex-rs/protocol/src/openai_models.rs`, requested as in `codex-rs/codex-api/src/endpoint/models.rs`):
`{"models": [ModelInfo]}`, where a model with `visibility` other than `list` is one the CLI keeps
out of its picker, and the CLI orders the rest by `priority`, lowest first, and takes the first as
its default (`build_available_models` and `mark_default_by_picker_visibility`).
"""

from __future__ import annotations

import logging
import math
import os
import re
import time
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

# `CHATGPT_CODEX_BASE_URL` in langchain_openai/chat_models/codex.py, the address the plan's answers
# go to, with Codex's `models` path. Spelled out because `main` imports this module, and `main`
# imports no provider package at module level (see `_wants_system_turns_first`).
CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models"

# The Codex backend is asked as a Codex client of this version, the way the CLI asks it
# (`client_version_to_whole` in codex-rs/models-manager/src/lib.rs). The backend can hold back a
# model from a client older than the model's `minimal_client_version`, so this follows the latest
# Codex release (rust-v0.167.0, published 2026-11-06), and a deployment can move it without a
# rebuild.
DEFAULT_CLIENT_VERSION = "0.167.0"
CLIENT_VERSION_VARIABLE = "CHATGPT_CODEX_CLIENT_VERSION"

# How long a listing is trusted, and how long to wait before asking again after a failed read.
CACHE_SECONDS = 6 * 60 * 60
RETRY_SECONDS = 5 * 60
FETCH_TIMEOUT_SECONDS = 10

# The reasoning efforts OpenBot's server and browser know by name. Codex has more (`ultra`,
# `persistent`, and values a model defines for itself); a model is offered with the ones in this
# list, since an effort the picker cannot name is one nobody can pick.
WIRE_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")

# What a provider says when it is asked for a model it does not serve. The server reads the same
# words in RUN_ERROR to refresh its own catalogue; this harness reads them to refresh the listing.
_MODEL_REFUSAL = re.compile(
    r"\bmodel\b[^\n]*\b(?:not supported|unsupported|unknown|does not exist|not found)\b"
    r"|\b(?:unknown|unsupported) model\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class PlanModel:
    id: str
    label: str
    efforts: tuple[str, ...]
    default_effort: str | None
    priority: int | None

    def as_entry(self) -> dict:
        entry: dict = {"id": self.id, "label": self.label}
        if self.efforts:
            entry["efforts"] = list(self.efforts)
        if self.default_effort:
            entry["default_effort"] = self.default_effort
        if self.priority is not None:
            entry["priority"] = self.priority
        return entry


def client_version() -> str:
    return (os.environ.get(CLIENT_VERSION_VARIABLE) or "").strip() or DEFAULT_CLIENT_VERSION


def _http_client() -> httpx.AsyncClient:
    # Redirects must never carry the plan's token anywhere else.
    return httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECONDS, follow_redirects=False)


def parse_listing(body) -> list[PlanModel]:
    """The listed models of a Codex `/models` body, in Codex's own order.

    A row that is not a model, or one without a `slug`, is skipped rather than failing the whole
    listing: the backend adds fields often, and a field this reader does not know is not a reason
    to offer nothing.
    """
    rows = body.get("models") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        raise ValueError("The Codex model listing has no `models` list.")
    models = []
    for row in rows:
        if not isinstance(row, dict) or row.get("visibility") != "list":
            continue
        slug = row.get("slug")
        if not isinstance(slug, str) or not slug.strip():
            continue
        label = row.get("display_name")
        levels = row.get("supported_reasoning_levels")
        efforts = []
        for level in levels if isinstance(levels, list) else []:
            effort = level.get("effort") if isinstance(level, dict) else None
            if effort in WIRE_EFFORTS and effort not in efforts:
                efforts.append(effort)
        default = row.get("default_reasoning_level")
        priority = row.get("priority")
        models.append(
            PlanModel(
                id=slug.strip(),
                label=label.strip() if isinstance(label, str) and label.strip() else slug.strip(),
                efforts=tuple(efforts),
                default_effort=default if default in WIRE_EFFORTS else None,
                priority=priority
                if isinstance(priority, int) and not isinstance(priority, bool)
                else None,
            )
        )
    # Stable, as Codex's `sort_by_key` is; a model without a priority goes last.
    models.sort(key=lambda model: math.inf if model.priority is None else model.priority)
    return models


async def fetch_listing(token_provider) -> list[PlanModel]:
    from langchain_openai.chat_models.codex import (
        ACCOUNT_ID_HEADER,
        ORIGINATOR_HEADER,
        _default_originator,
    )

    token = await token_provider.aget_token()
    headers = {"Authorization": f"Bearer {token.access_token}", "Accept": "application/json"}
    if token.account_id:
        headers[ACCOUNT_ID_HEADER] = token.account_id
    # The same `originator` the plan's answers carry (`_ChatOpenAICodex.originator`).
    originator = _default_originator()
    if originator:
        headers[ORIGINATOR_HEADER] = originator
    async with _http_client() as client:
        response = await client.get(
            CODEX_MODELS_URL,
            params={"client_version": client_version()},
            headers=headers,
        )
    response.raise_for_status()
    return parse_listing(response.json())


class PlanListing:
    """The last listing that was read, trusted for `CACHE_SECONDS`.

    A failed refresh keeps the last good listing, and is not retried for `RETRY_SECONDS`, so an
    unreachable backend costs one timeout every few minutes rather than one on every answer.
    """

    def __init__(self):
        self.clear()

    def clear(self):
        self._models: list[PlanModel] | None = None
        self._next_read = -math.inf

    def invalidate(self):
        """Read the listing again on next use, keeping this one in case that read fails."""
        self._next_read = -math.inf

    async def models(self, token_provider) -> list[PlanModel] | None:
        now = time.monotonic()
        if now < self._next_read:
            return self._models
        try:
            models = await fetch_listing(token_provider)
        except Exception as error:  # A listing that cannot be read never fails an answer.
            # The type only: an HTTP error's text names the URL and can quote the response.
            logger.warning(
                "The ChatGPT plan's model listing could not be read (%s).", type(error).__name__
            )
            self._next_read = now + RETRY_SECONDS
            return self._models
        self._models = models
        self._next_read = now + CACHE_SECONDS
        return models


PLAN_MODELS = PlanListing()


def is_model_refusal(message: str) -> bool:
    """Whether a provider's refusal, in its own words, is about the model it was asked for."""
    return bool(_MODEL_REFUSAL.search(message))


def plan_model(configured: str, offered: list[PlanModel] | None) -> str:
    """The model a plan answers on when the server did not choose one.

    The configured model when the plan offers it, otherwise the plan's own default: the first
    listed model in Codex's order. With no listing to go by, the configured model, as before.
    """
    if not offered or any(model.id == configured for model in offered):
        return configured
    return offered[0].id
