"""The Sign in with ChatGPT credential record this engine runs on, and its renewal.

OpenBot Desktop signs the person in with OpenAI's official Sign in with ChatGPT plan usage flow
(https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and writes the credential
record to a file the Compose file mounts here, read-write. The access token lasts an hour
(https://developers.openai.com/siwc/token-sharing-open-source/token-reference#token-lifetimes); the
refresh token beside it rotates on every refresh, so the renewal is written back to the same file,
or the next start would replay a refresh token that was already spent.

Refresh is the documented one
(https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#refreshing-tokens):
a form POST of `grant_type=refresh_token`, the issued `client_id`, the `refresh_token` and
`resource=https://api.openai.com/v1`, with no `scope`, serialized so two processes never race a
rotating token. No token is ever logged.
"""

from __future__ import annotations

import asyncio
import base64
import fcntl
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
RESOURCE = "https://api.openai.com/v1"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
# Renew this long before the access token's own expiry, so a long run does not start on a token
# that lapses part way through its stream.
RENEW_BEFORE_SECONDS = 300

# The codes OpenAI documents as an unusable refresh token: sign in again
# (https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery#refresh-errors).
UNUSABLE_REFRESH = {
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
}


class SignInNeeded(RuntimeError):
    """The saved sign-in can no longer be used; the person has to sign in to ChatGPT again."""


@dataclass
class Record:
    data: dict[str, Any]

    @property
    def access_token(self) -> str:
        return str(self.data.get("access_token") or "")

    @property
    def refresh_token(self) -> str:
        return str(self.data.get("refresh_token") or "")

    @property
    def client_id(self) -> str:
        return str(self.data.get("client_id") or "")

    @property
    def scopes(self) -> list[str]:
        scopes = self.data.get("scopes")
        if isinstance(scopes, list):
            return [str(scope) for scope in scopes]
        return str(self.data.get("scope") or "").split()

    def expires_at(self) -> float:
        """When the access token lapses: its own `exp` claim, else the record's expiry."""
        claim = _jwt_claim(self.access_token, "exp")
        if isinstance(claim, (int, float)):
            return float(claim)
        expires_at = self.data.get("expires_at")
        if isinstance(expires_at, (int, float)):
            return float(expires_at)
        return 0.0


def _jwt_claim(token: str, name: str) -> Any:
    """One claim of a JWT's payload, unverified: only its expiry is read, to know when to renew."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload)).get(name)
    except (ValueError, json.JSONDecodeError):
        return None


def read(path: Path) -> Record:
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError as error:
        raise SignInNeeded("No ChatGPT sign-in is saved.") from error
    if not isinstance(data, dict) or not data.get("access_token"):
        raise SignInNeeded("No ChatGPT sign-in is saved.")
    record = Record(data)
    if PLAN_SCOPE not in record.scopes:
        raise SignInNeeded("The ChatGPT sign-in does not allow using the plan.")
    return record


def write(path: Path, data: dict[str, Any]) -> None:
    """Replace the record atomically, owner-only, in the mounted directory."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as file:
            json.dump(data, file)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def renewed(record: Record, answer: dict[str, Any], now: float) -> dict[str, Any]:
    """The record after a successful refresh: token, expiry, scopes and refresh token together."""
    data = dict(record.data)
    data["access_token"] = answer["access_token"]
    if answer.get("refresh_token"):
        data["refresh_token"] = answer["refresh_token"]
    if answer.get("id_token"):
        data["id_token"] = answer["id_token"]
    if answer.get("token_type"):
        data["token_type"] = answer["token_type"]
    expires_in = answer.get("expires_in")
    if isinstance(expires_in, (int, float)):
        data["expires_in"] = int(expires_in)
        data["expires_at"] = int(now + expires_in)
    if answer.get("scope"):
        data["scopes"] = sorted(str(answer["scope"]).split())
    data["saved_at"] = datetime.fromtimestamp(now, tz=timezone.utc).isoformat()
    return data


class Credentials:
    """The access token for the next model call, renewed when it is about to lapse."""

    def __init__(self, path: Path, token_url: str = TOKEN_URL):
        self.path = path
        self.token_url = token_url
        self._lock = asyncio.Lock()

    async def access_token(self) -> str:
        record = read(self.path)
        if record.expires_at() - time.time() > RENEW_BEFORE_SECONDS:
            return record.access_token
        async with self._lock:
            return await asyncio.to_thread(self._refresh_locked)

    def _refresh_locked(self) -> str:
        # A file lock beside the record, so another process (a second engine, Desktop) never spends
        # the same rotating refresh token.
        lock_path = self.path.with_name(f".{self.path.name}.lock")
        with open(lock_path, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            record = read(self.path)
            if record.expires_at() - time.time() > RENEW_BEFORE_SECONDS:
                return record.access_token
            if not record.refresh_token or not record.client_id:
                raise SignInNeeded("The ChatGPT sign-in has no refresh token.")
            response = httpx.post(
                self.token_url,
                data={
                    "grant_type": "refresh_token",
                    "client_id": record.client_id,
                    "refresh_token": record.refresh_token,
                    "resource": RESOURCE,
                },
                headers={"Accept": "application/json"},
                timeout=30,
            )
            try:
                answer = response.json()
            except json.JSONDecodeError:
                answer = {}
            if response.status_code != 200:
                code = str(answer.get("error") or answer.get("code") or response.status_code)
                if code in UNUSABLE_REFRESH:
                    raise SignInNeeded(f"The ChatGPT sign-in has ended ({code}).")
                raise RuntimeError(f"Renewing the ChatGPT sign-in failed ({code}).")
            if not answer.get("access_token"):
                raise RuntimeError("Renewing the ChatGPT sign-in returned no access token.")
            data = renewed(record, answer, time.time())
            if PLAN_SCOPE not in Record(data).scopes:
                raise SignInNeeded("The renewed ChatGPT sign-in does not allow using the plan.")
            write(self.path, data)
            return str(data["access_token"])
