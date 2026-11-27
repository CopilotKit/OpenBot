"""A handed-back tool call signed for Gemini, for every Python harness OpenBot runs.

Gemini 3 and later refuse a function call in the current turn that does not carry the thought
signature the model gave it: "Function call is missing a thought_signature in functionCall parts".
OpenBot runs each tool between two runs, and an AG-UI tool call has no field for a signature, so a
call always comes back to the harness without its own. Holding the real one between runs would
mean holding it on whichever replica answered the first. Google documents a value for a history
whose signatures are not available, `skip_thought_signature_validator`, and this module puts it on
every call that has none.

THE FRAMEWORKS BUILD THE REQUEST, each its own way (LiteLLM, google-genai, the OpenAI SDK under
AG2 or LangChain). So the signature goes in where every one of them ends up, as `run_model_key.py`
puts a run's key in: the HTTP request. `install()` wraps `httpx` and `httpx2` sends and `aiohttp`
requests (google-genai sends through `aiohttp` when it is installed), and rewrites a request body
only when it is a Gemini request:

- Gemini's own API: a POST to `.../models/gemini-...:generateContent` or `:streamGenerateContent`,
  whatever the host (a base url may name a gateway or a mock in front of Gemini). Each
  `functionCall` part in `contents` with no `thoughtSignature` is given the placeholder.
- Google's OpenAI-compatible endpoint (`generativelanguage.googleapis.com/.../openai/`), or
  OpenBot's model gateway asked for a Gemini model: each assistant `tool_calls` entry in
  `messages` with no `extra_content.google.thought_signature` is given the placeholder there.

A signature the request already carries is kept: a framework that held the real one (inside one
run's tool loop, or brought back by the server) sends it as it was. Every other request, to any
other provider or for any other model, is sent byte for byte as it was built.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlsplit

#: Google's documented stand-in for a signature that is not available.
GEMINI_UNSIGNED_CALL = "skip_thought_signature_validator"

GOOGLE_HOST = "generativelanguage.googleapis.com"
GATEWAY_PATH = "/api/model-provider/"

_NATIVE_PATH = re.compile(r"/models/([^/:]+):(?:stream)?[gG]enerateContent$")


def is_gemini_model(model: Any) -> bool:
    """Whether a model name names a Gemini model: `gemini-4-hydrogen`, `models/gemini-3.8-flash`.

    A gateway's namespaced name (`google/gemini-3.8-flash`, `gemini/gemini-3.8-flash`) is the
    model it names.
    """
    if not isinstance(model, str):
        return False
    return model.strip().lower().rsplit("/", 1)[-1].startswith("gemini-")


def sign_contents(body: Any) -> bool:
    """Every unsigned `functionCall` part in a generateContent body, signed. Whether any was."""
    if not isinstance(body, dict) or not isinstance(body.get("contents"), list):
        return False
    signed = False
    for content in body["contents"]:
        if not isinstance(content, dict) or not isinstance(content.get("parts"), list):
            continue
        for part in content["parts"]:
            if not isinstance(part, dict):
                continue
            if "functionCall" not in part and "function_call" not in part:
                continue
            if part.get("thoughtSignature") or part.get("thought_signature"):
                continue
            part["thoughtSignature"] = GEMINI_UNSIGNED_CALL
            signed = True
    return signed


def sign_messages(body: Any) -> bool:
    """Every unsigned assistant tool call in a Chat Completions body, signed. Whether any was."""
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        return False
    signed = False
    for message in body["messages"]:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            extra = call.get("extra_content")
            extra = extra if isinstance(extra, dict) else {}
            google = extra.get("google")
            google = google if isinstance(google, dict) else {}
            if google.get("thought_signature"):
                continue
            call["extra_content"] = {
                **extra,
                "google": {**google, "thought_signature": GEMINI_UNSIGNED_CALL},
            }
            signed = True
    return signed


def signed_body(method: str, url: str, content: bytes | None) -> bytes | None:
    """The request body with its Gemini tool calls signed, or None to send it as it was."""
    if not content or (method or "").upper() != "POST":
        return None
    parts = urlsplit(url)
    path = parts.path or ""
    native = _NATIVE_PATH.search(path)
    chat = path.endswith("/chat/completions")
    if native:
        if not is_gemini_model(native.group(1)):
            return None
    elif not chat:
        return None
    try:
        body = json.loads(content)
    except (ValueError, UnicodeDecodeError):
        return None
    if native:
        changed = sign_contents(body)
    else:
        host = (parts.hostname or "").lower()
        if not is_gemini_model(body.get("model") if isinstance(body, dict) else None):
            return None
        if host != GOOGLE_HOST and GATEWAY_PATH not in path:
            return None
        changed = sign_messages(body)
    if not changed:
        return None
    return json.dumps(body).encode("utf-8")


_installed = False


def install() -> None:
    """Every Gemini request this process sends carries a signature on each tool call. Idempotent."""
    global _installed
    if _installed:
        return
    import importlib

    # Whatever is importable and is the client it looks like: a module a test or a framework put
    # in its place (a stub with no `Client`) is left alone rather than stop the harness at import.
    for name in ("httpx", "httpx2"):
        try:
            module = importlib.import_module(name)
        except ImportError:
            continue
        if all(hasattr(module, attribute) for attribute in ("Client", "AsyncClient", "Request")):
            _patch_httpx(module)
    try:
        import aiohttp
    except ImportError:
        pass
    else:
        session = getattr(aiohttp, "ClientSession", None)
        if session is not None and hasattr(session, "_request"):
            _patch_aiohttp(session)
    _installed = True


def _resigned(module, request):
    """An httpx request with its Gemini tool calls signed, or the request itself."""
    try:
        content = request.content
    except Exception:  # a streaming body: not one a framework builds for a model call
        return request
    body = signed_body(request.method, str(request.url), content)
    if body is None:
        return request
    headers = [
        (key, value)
        for key, value in request.headers.multi_items()
        if key.lower() not in ("content-length", "transfer-encoding")
    ]
    return module.Request(
        request.method,
        request.url,
        headers=headers,
        content=body,
        extensions=request.extensions,
    )


def _patch_httpx(module) -> None:
    client, async_client = module.Client, module.AsyncClient
    sync_send = client.send
    async_send = async_client.send

    def send(self, request, *args, **kwargs):
        return sync_send(self, _resigned(module, request), *args, **kwargs)

    async def asend(self, request, *args, **kwargs):
        return await async_send(self, _resigned(module, request), *args, **kwargs)

    client.send = send
    async_client.send = asend


def _patch_aiohttp(session_class) -> None:
    request = session_class._request

    async def _request(self, method, str_or_url, *args, **kwargs):
        data = kwargs.get("data")
        if isinstance(data, str):
            data = data.encode("utf-8")
        if isinstance(data, (bytes, bytearray)):
            body = signed_body(method, str(str_or_url), bytes(data))
            if body is not None:
                kwargs["data"] = body
        elif kwargs.get("json") is not None:
            body = signed_body(method, str(str_or_url), json.dumps(kwargs["json"]).encode("utf-8"))
            if body is not None:
                kwargs["json"] = json.loads(body)
        else:
            body = None
        if body is not None and isinstance(kwargs.get("headers"), dict):
            # The body grew: a length the caller worked out is no longer its length.
            kwargs["headers"] = {
                key: value
                for key, value in kwargs["headers"].items()
                if key.lower() != "content-length"
            }
        return await request(self, method, str_or_url, *args, **kwargs)

    session_class._request = _request
