import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import httpx2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import main


@pytest.fixture(autouse=True)
def provider_environment(monkeypatch):
    for name in [
        "ALL_PROXY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "BOT_MODEL",
        "BOT_PROVIDER",
        "CHATGPT_AUTH_FILE",
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
    result = await main.answer({"messages": [{"role": "user", "content": "Say hello."}]})
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
        {
            "id": "chatcmpl-openbot-ci",
            "object": "chat.completion",
            "created": 0,
            "model": "gpt-ci",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "openai proof"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        },
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
async def test_nonblank_openai_compatible_endpoint_stays_supported(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-compatible-ci")
    monkeypatch.setenv("BOT_MODEL", "gpt-compatible")
    monkeypatch.setenv("OPENAI_BASE_URL", "  http://127.0.0.1:4310/v1  ")

    result, captured = await _run_answer_with_httpx2_capture(
        monkeypatch,
        {
            "id": "chatcmpl-compatible-ci",
            "object": "chat.completion",
            "created": 0,
            "model": "gpt-compatible",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "compatible proof"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        },
    )

    assert result["messages"][0].content == "compatible proof"
    assert os.environ["OPENAI_BASE_URL"] == "http://127.0.0.1:4310/v1"
    assert captured[0]["url"] == "http://127.0.0.1:4310/v1/chat/completions"


@pytest.mark.asyncio
async def test_anthropic_selection_reaches_anthropic_boundary_without_openai_key(
    monkeypatch,
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-openbot-ci")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:4311")
    monkeypatch.setenv("BOT_PROVIDER", "anthropic")
    monkeypatch.setenv("BOT_MODEL", "claude-sonnet-4-5")

    result, captured = await _run_answer_with_httpx2_capture(
        monkeypatch,
        {
            "id": "msg-openbot-ci",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-5",
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
    assert captured[0]["body"]["model"] == "claude-sonnet-4-5"
    assert captured[0]["body"]["messages"] == [
        {"role": "user", "content": "Say hello."}
    ]


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
