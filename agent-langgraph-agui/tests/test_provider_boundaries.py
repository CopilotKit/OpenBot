import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import httpx2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import main

_LOOPBACK_SOCKET_GUARD_INSTALLED = False


def _openai_response(model, content):
    return {
        "id": "chatcmpl-openbot-ci",
        "object": "chat.completion",
        "created": 0,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


def _install_loopback_socket_guard():
    global _LOOPBACK_SOCKET_GUARD_INSTALLED
    if _LOOPBACK_SOCKET_GUARD_INSTALLED:
        return

    def guard(event, args):
        if event != "socket.connect":
            return
        _sock, address = args
        if not isinstance(address, tuple) or not address:
            raise RuntimeError(f"Blocked non-IP socket connect: {address!r}")
        host = address[0]
        if host not in {"127.0.0.1", "::1", "localhost"}:
            raise RuntimeError(f"Blocked non-loopback socket connect: {address!r}")

    sys.addaudithook(guard)
    _LOOPBACK_SOCKET_GUARD_INSTALLED = True


def _google_response(content):
    return {
        "candidates": [
            {
                "content": {
                    "parts": [{"text": content}],
                    "role": "model",
                },
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "usageMetadata": {
            "promptTokenCount": 1,
            "candidatesTokenCount": 1,
            "totalTokenCount": 2,
        },
        "modelVersion": "gemini-2.5-flash",
    }


@pytest.fixture
def compatible_endpoint():
    captured = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            captured.append({"path": self.path, "body": body})
            response = json.dumps(
                _openai_response(body["model"], "compatible proof")
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            # Requests are asserted through captured, without noisy access logs.
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", captured
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.fixture
def google_genai_endpoint():
    captured = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            captured.append(
                {
                    "path": self.path,
                    "x_goog_api_key_present": bool(
                        self.headers.get("x-goog-api-key")
                    ),
                    "body": body,
                }
            )
            response = json.dumps(_google_response("google loopback proof")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", captured
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.fixture(autouse=True)
def provider_environment(monkeypatch):
    for name in list(os.environ):
        if name.startswith(("LANGCHAIN_", "LANGSMITH_")):
            monkeypatch.delenv(name)
    for name in [
        "ALL_PROXY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "BOT_MODEL",
        "BOT_PROVIDER",
        "CHATGPT_AUTH_FILE",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_BASE_URL",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "all_proxy",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    ]:
        monkeypatch.delenv(name, raising=False)


async def _run_answer_with_httpx2_capture(monkeypatch, response_json):
    captured = []

    async def send(self, request, **kwargs):
        captured.append(
            {
                "url": str(request.url),
                "headers": dict(request.headers),
                "body": json.loads(request.content.decode()),
            }
        )
        return httpx2.Response(200, json=response_json, request=request)

    monkeypatch.setattr(httpx2.AsyncClient, "send", send)
    result = await main.answer(
        {"messages": [{"role": "user", "content": "Say hello."}]}
    )
    return result, captured


@pytest.mark.asyncio
async def test_openai_key_without_compatible_endpoint_uses_sdk_default_boundary(
    monkeypatch,
):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openbot-ci")
    monkeypatch.setenv("BOT_MODEL", "gpt-ci")
    monkeypatch.setenv("OPENAI_BASE_URL", "")

    result, captured = await _run_answer_with_httpx2_capture(
        monkeypatch,
        _openai_response("gpt-ci", "openai proof"),
    )

    assert result["messages"][0].content == "openai proof"
    assert os.environ.get("OPENAI_BASE_URL") is None
    assert len(captured) == 1
    assert captured[0]["url"] == "https://api.openai.com/v1/chat/completions"
    assert captured[0]["headers"]["authorization"] == "Bearer sk-openbot-ci"
    assert captured[0]["body"] == {
        "messages": [{"content": "Say hello.", "role": "user"}],
        "model": "gpt-ci",
        "stream": False,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "model", "request_model"),
    [
        ("openai", "gpt-compatible", "gpt-compatible"),
        ("openai", "qwen2.5:1.5b", "qwen2.5:1.5b"),
        (
            "openai",
            "namespace/model:variant:revision",
            "namespace/model:variant:revision",
        ),
        ("openai", "claude-compatible:latest", "claude-compatible:latest"),
        ("anthropic", "openai:qwen2.5:1.5b", "qwen2.5:1.5b"),
    ],
)
async def test_compatible_model_id_reaches_real_http_boundary(
    monkeypatch, compatible_endpoint, provider, model, request_model
):
    base_url, captured = compatible_endpoint
    monkeypatch.setenv("OPENAI_API_KEY", "sk-compatible-ci")
    monkeypatch.setenv("BOT_PROVIDER", provider)
    monkeypatch.setenv("BOT_MODEL", model)
    monkeypatch.setenv("OPENAI_BASE_URL", f"  {base_url}  ")

    result = await main.answer(
        {"messages": [{"role": "user", "content": "Say hello."}]}
    )

    assert result["messages"][0].content == "compatible proof"
    assert os.environ["OPENAI_BASE_URL"] == base_url
    assert captured == [
        {
            "path": "/v1/chat/completions",
            "body": {
                "messages": [{"content": "Say hello.", "role": "user"}],
                "model": request_model,
                "stream": False,
            },
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", [None, "", "   "])
@pytest.mark.parametrize("model", ["claude-compatible:latest", "qwen2.5:1.5b"])
async def test_blank_provider_keeps_opaque_model_at_compatible_endpoint(
    monkeypatch, compatible_endpoint, provider, model
):
    _install_loopback_socket_guard()
    base_url, captured = compatible_endpoint
    if provider is not None:
        monkeypatch.setenv("BOT_PROVIDER", provider)
    monkeypatch.setenv("BOT_MODEL", model)
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-compatible-key")
    monkeypatch.setenv("OPENAI_BASE_URL", base_url)
    # A Claude-like compatible model must not route through another available provider.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-anthropic-key")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", base_url.removesuffix("/v1"))

    result = await main.answer(
        {"messages": [{"role": "user", "content": "Say hello."}]}
    )

    assert result["messages"][0].content == "compatible proof"
    assert captured == [
        {
            "path": "/v1/chat/completions",
            "body": {
                "messages": [{"content": "Say hello.", "role": "user"}],
                "model": model,
                "stream": False,
            },
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "model", "request_model"),
    [
        ("anthropic", "claude-sonnet-4-5", "claude-sonnet-4-5"),
        ("openai", "anthropic:claude-sonnet-4-5", "claude-sonnet-4-5"),
        ("anthropic", "claude-compatible:latest", "claude-compatible:latest"),
    ],
)
async def test_anthropic_selection_reaches_anthropic_boundary_without_openai_key(
    monkeypatch, provider, model, request_model
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-openbot-ci")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:4311")
    monkeypatch.setenv("BOT_PROVIDER", provider)
    monkeypatch.setenv("BOT_MODEL", model)

    result, captured = await _run_answer_with_httpx2_capture(
        monkeypatch,
        {
            "id": "msg-openbot-ci",
            "type": "message",
            "role": "assistant",
            "model": request_model,
            "content": [{"type": "text", "text": "anthropic proof"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        },
    )

    assert result["messages"][0].content == "anthropic proof"
    assert "OPENAI_API_KEY" not in os.environ
    assert captured[0]["url"] == "http://127.0.0.1:4311/v1/messages"
    assert captured[0]["headers"]["x-api-key"] == "sk-ant-openbot-ci"
    assert captured[0]["headers"]["anthropic-version"] == "2023-06-01"
    assert captured[0]["body"]["model"] == request_model
    assert captured[0]["body"]["messages"] == [
        {"role": "user", "content": "Say hello."}
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "model"),
    [
        ("google", "gemini-2.5-flash"),
        ("openai", "google_genai:gemini-2.5-flash"),
    ],
)
async def test_google_provider_reaches_google_genai_boundary(
    monkeypatch, google_genai_endpoint, provider, model
):
    _install_loopback_socket_guard()
    base_url, captured = google_genai_endpoint
    monkeypatch.setenv("GOOGLE_API_KEY", "synthetic-google")
    monkeypatch.setenv("GOOGLE_GENERATIVE_AI_BASE_URL", f"  {base_url}  ")
    monkeypatch.setenv("BOT_PROVIDER", provider)
    monkeypatch.setenv("BOT_MODEL", model)

    result = await main.answer(
        {"messages": [{"role": "user", "content": "Say hello."}]}
    )

    assert result["messages"][0].content == "google loopback proof"
    assert captured == [
        {
            "path": "/v1beta/models/gemini-2.5-flash:generateContent",
            "x_goog_api_key_present": True,
            "body": {
                "contents": [
                    {
                        "parts": [{"text": "Say hello."}],
                        "role": "user",
                    }
                ],
                "generationConfig": {
                    "candidateCount": 1,
                    "temperature": 0.7,
                },
                "safetySettings": [],
            },
        }
    ]


def _write_synthetic_chatgpt_store(path: Path):
    from langchain_openai.chatgpt_oauth import _ChatGPTToken
    from langchain_openai.chat_models.codex import _FileChatGPTOAuthTokenProvider

    provider = _FileChatGPTOAuthTokenProvider(path=path)
    provider._write_to_disk(
        _ChatGPTToken(
            access_token="synthetic-access",
            refresh_token="synthetic-refresh",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            account_id="synthetic-account",
            plan_type="plus",
            user_id="synthetic-user",
        )
    )


def test_configured_chatgpt_auth_file_missing_fails_before_fallback(
    monkeypatch, tmp_path
):
    missing_file = tmp_path / "missing-chatgpt-auth.json"
    monkeypatch.setenv("CHATGPT_AUTH_FILE", str(missing_file))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-be-used")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:9/v1")

    def fail_if_fallback_is_built(*_args, **_kwargs):
        raise AssertionError("fallback provider model was constructed")

    monkeypatch.setattr(main, "init_chat_model", fail_if_fallback_is_built)

    with pytest.raises(FileNotFoundError, match="CHATGPT_AUTH_FILE.*missing file"):
        main._model()


def test_configured_chatgpt_auth_file_directory_fails_before_fallback(
    monkeypatch, tmp_path
):
    directory_path = tmp_path / "auth-directory"
    directory_path.mkdir()
    monkeypatch.setenv("CHATGPT_AUTH_FILE", str(directory_path))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-be-used")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:9/v1")

    def fail_if_fallback_is_built(*_args, **_kwargs):
        raise AssertionError("fallback provider model was constructed")

    monkeypatch.setattr(main, "init_chat_model", fail_if_fallback_is_built)

    with pytest.raises(IsADirectoryError, match="CHATGPT_AUTH_FILE.*directory"):
        main._model()


def test_configured_chatgpt_auth_file_unreadable_fails_before_fallback(
    monkeypatch, tmp_path
):
    unreadable_file = tmp_path / "unreadable-chatgpt-auth.json"
    _write_synthetic_chatgpt_store(unreadable_file)
    unreadable_file.chmod(0)
    if os.access(unreadable_file, os.R_OK):
        pytest.skip("platform still reports chmod(0) file as readable")
    monkeypatch.setenv("CHATGPT_AUTH_FILE", str(unreadable_file))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-be-used")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:9/v1")

    def fail_if_fallback_is_built(*_args, **_kwargs):
        raise AssertionError("fallback provider model was constructed")

    monkeypatch.setattr(main, "init_chat_model", fail_if_fallback_is_built)

    try:
        with pytest.raises(PermissionError, match="CHATGPT_AUTH_FILE.*not readable"):
            main._model()
    finally:
        unreadable_file.chmod(0o600)


def test_configured_chatgpt_auth_file_selects_codex_model(monkeypatch, tmp_path):
    auth_file = tmp_path / "chatgpt-auth.json"
    _write_synthetic_chatgpt_store(auth_file)
    monkeypatch.setenv("CHATGPT_AUTH_FILE", str(auth_file))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-be-used")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("BOT_MODEL", "gpt-5.5")

    model = main._model()
    token = model.token_provider.get_token()

    assert (
        f"{type(model).__module__}.{type(model).__name__}"
        == "langchain_openai.chat_models.codex._ChatOpenAICodex"
    )
    assert type(model.token_provider).__name__ == "_FileChatGPTOAuthTokenProvider"
    assert str(model.token_provider.path) == str(auth_file)
    assert token.access_token == "synthetic-access"
    assert token.refresh_token == "synthetic-refresh"


def _run_chatgpt_writer_container(host_source: Path, container_target: str):
    writer = host_source.parent / "writer.py"
    writer.write_text(
        """
import json
from datetime import datetime, timedelta, timezone
from importlib.metadata import version
from pathlib import Path
from langchain_openai.chatgpt_oauth import _ChatGPTToken
from langchain_openai.chat_models.codex import _FileChatGPTOAuthTokenProvider

provider = _FileChatGPTOAuthTokenProvider(
    path=Path('/root/.langchain/chatgpt-auth.json')
)
provider._write_to_disk(
    _ChatGPTToken(
        access_token='synthetic-access',
        refresh_token='synthetic-refresh',
        expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        account_id='synthetic-account',
        plan_type='plus',
        user_id='synthetic-user',
    )
)
print(json.dumps({
    'version': version('langchain-openai'),
    'written': json.loads(Path('/root/.langchain/chatgpt-auth.json').read_text()),
}))
""",
        encoding="utf-8",
    )
    return subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--mount",
            f"type=bind,source={host_source},target={container_target}",
            "--mount",
            f"type=bind,source={writer},target=/tmp/writer.py,readonly",
            "python:3.12-slim",
            "sh",
            "-lc",
            "python -m pip install --quiet --root-user-action=ignore langchain-openai==1.6.0 && python /tmp/writer.py",
        ],
        check=False,
        text=True,
        capture_output=True,
        timeout=180,
    )


def test_chatgpt_token_provider_atomic_writer_survives_directory_mount():
    root = Path(tempfile.mkdtemp(prefix="openbot-id6-directory-", dir="/tmp"))
    try:
        mount_dir = root / "langchain"
        mount_dir.mkdir()
        token_file = mount_dir / "chatgpt-auth.json"
        token_file.write_text("{}", encoding="utf-8")

        result = _run_chatgpt_writer_container(mount_dir, "/root/.langchain")

        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout.splitlines()[-1])
        assert payload["version"] == "1.6.0"
        assert payload["written"]["access_token"] == "synthetic-access"
        assert payload["written"]["refresh_token"] == "synthetic-refresh"
        host_payload = json.loads(token_file.read_text(encoding="utf-8"))
        assert host_payload["access_token"] == "synthetic-access"
        assert host_payload["refresh_token"] == "synthetic-refresh"
    finally:
        shutil.rmtree(root)


def test_chatgpt_token_provider_atomic_writer_fails_on_single_file_mount():
    root = Path(tempfile.mkdtemp(prefix="openbot-id6-file-", dir="/tmp"))
    try:
        host_file = root / "chatgpt-auth.json"
        host_file.write_text("{}", encoding="utf-8")

        result = _run_chatgpt_writer_container(
            host_file,
            "/root/.langchain/chatgpt-auth.json",
        )

        assert result.returncode != 0
        assert "Device or resource busy" in result.stderr or "Errno 16" in result.stderr
        assert host_file.read_text(encoding="utf-8") == "{}"
    finally:
        shutil.rmtree(root)
