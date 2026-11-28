"""The models the signed-in ChatGPT account offers, read from OpenAI's own listing for the plan.

`GET https://api.openai.com/v1/models` with the plan's access token answers the account's model
catalog: `{"models": [...]}`, each row with a `slug` to send as `model`, a `display_name`, and a
`visibility` of `list` for the ones meant for a picker, in the server's own order
(https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference). A row may also
carry its reasoning levels (`supported_reasoning_levels`, `default_reasoning_level`) and a
`priority`; those are passed on when present.

Served to OpenBot's server as `GET /models` in the shape every plan harness answers with, so the
model picker lists exactly what this account can run.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

import httpx

logger = logging.getLogger("agent-openai-agents")

CACHE_SECONDS = 6 * 60 * 60
RETRY_SECONDS = 5 * 60
FETCH_TIMEOUT_SECONDS = 15

# The reasoning efforts OpenBot's server and picker know by name.
WIRE_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")


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


def parse_listing(body) -> list[PlanModel]:
    """The account's listed models, in the server's order. A row it can't read is skipped."""
    rows = body.get("models") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        raise ValueError("The ChatGPT model listing has no `models` list.")
    models = []
    for row in rows:
        if not isinstance(row, dict) or row.get("visibility") != "list":
            continue
        slug = row.get("slug") or row.get("id")
        if not isinstance(slug, str) or not slug.strip():
            continue
        label = row.get("display_name")
        levels = row.get("supported_reasoning_levels")
        efforts: list[str] = []
        for level in levels if isinstance(levels, list) else []:
            effort = level.get("effort") if isinstance(level, dict) else level
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
                priority=priority if isinstance(priority, int) and not isinstance(priority, bool) else None,
            )
        )
    return models


class PlanListing:
    """The last listing read, trusted for `CACHE_SECONDS`; a failed read keeps it and waits."""

    def __init__(self, url: str, token: Callable[[], Awaitable[str]]) -> None:
        self.url = url
        self.token = token
        self._models: list[PlanModel] | None = None
        self._next_read = -math.inf

    def invalidate(self) -> None:
        self._next_read = -math.inf

    async def models(self) -> list[PlanModel] | None:
        now = time.monotonic()
        if now < self._next_read:
            return self._models
        try:
            # Redirects never carry the plan's token anywhere else.
            async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECONDS, follow_redirects=False) as http:
                response = await http.get(
                    self.url, headers={"Authorization": f"Bearer {await self.token()}"}
                )
            response.raise_for_status()
            models = parse_listing(response.json())
        except Exception as error:  # A listing that can't be read never fails an answer.
            # The type only: an HTTP error's text can quote the response.
            logger.warning("The ChatGPT model listing could not be read (%s).", type(error).__name__)
            self._next_read = now + RETRY_SECONDS
            return self._models
        self._models = models
        self._next_read = now + CACHE_SECONDS
        return models


def choose(picked: str, configured: str, listed: list[PlanModel] | None) -> tuple[str, str]:
    """The model a run answers on, and why.

    The model picked in OpenBot when the account lists it. Otherwise the configured one
    (`CHATGPT_MODEL`) when listed, else the account's first listed model. With no listing to go by,
    the pick, then the configured one: OpenBot's server only offers what the listing it read had.
    """
    ids = [model.id for model in listed or []]
    if picked and (not listed or picked in ids):
        return picked, "picked in OpenBot"
    if listed:
        if configured and configured in ids:
            return configured, "configured" if not picked else f"configured; {picked} is not offered"
        why = "the account's first listed model"
        return ids[0], why if not picked else f"{why}; {picked} is not offered"
    if configured:
        return configured, "configured"
    raise RuntimeError("The ChatGPT account lists no model this Bot can use.")
