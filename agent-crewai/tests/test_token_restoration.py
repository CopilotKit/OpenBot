"""Exercise the role test's real pytest teardown in an isolated process."""

import argparse
import ipaddress
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn


ROLE_TEST = "test_crewai_endpoint_preserves_leading_bot_role_for_provider"


def isolated_environment(directory):
    directory.mkdir(parents=True, exist_ok=True)
    inherited = (
        "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "CODEX_HOME",
        "PATH", "LANG", "SYSTEMROOT", "WINDIR",
    )
    environment = {name: os.environ[name] for name in inherited if name in os.environ}
    environment.update(
        OTEL_SDK_DISABLED="true",
        CREWAI_TELEMETRY_DISABLED="true",
        CREWAI_STORAGE_DIR=str(directory / "crewai"),
        LITELLM_LOCAL_MODEL_COST_MAP="True",
        PYTEST_DISABLE_PLUGIN_AUTOLOAD="1",
        PYTHONPYCACHEPREFIX=str(directory / "pycache"),
        TMPDIR=str(directory),
    )
    return environment


def prohibit_external_connections(event, arguments):
    if event == "socket.getaddrinfo":
        host = arguments[0]
    elif event in ("socket.connect", "socket.sendto"):
        address = arguments[1]
        if not isinstance(address, tuple):
            raise RuntimeError("Only loopback TCP/IP is allowed in this probe")
        host = address[0]
    else:
        return
    if host != "localhost" and not ipaddress.ip_address(host).is_loopback:
        raise RuntimeError("External network access is prohibited in this probe")


class RoleTestLifecycle:
    def __init__(self, failure):
        self.failure = failure
        self.role_assertion_passed = False
        self.phases = {}

    def pytest_collection_modifyitems(self, items):
        assert len(items) == 1 and items[0].name == ROLE_TEST
        original = items[0].obj

        def exercise_role_test(monkeypatch):
            original(monkeypatch)
            self.role_assertion_passed = True
            if self.failure == "assertion":
                assert False, "injected assertion after role test"
            if self.failure == "exception":
                raise RuntimeError("injected exception after role test")

        items[0].obj = exercise_role_test

    def pytest_runtest_logreport(self, report):
        self.phases[report.when] = report.outcome


def auth_statuses(app, header):
    """Use real loopback HTTP after pytest has returned in this same process."""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]})
        thread.start()
        try:
            deadline = time.monotonic() + 10
            while not server.started and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(0.01)
            assert server.started, "loopback app server did not start"
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5, trust_env=False) as client:
                return {
                    "health": client.get("/health").status_code,
                    "previous": client.post("/", headers={header: "synthetic-original-token"}, json={}).status_code,
                    "test": client.post("/", headers={header: "test-token"}, json={}).status_code,
                    "missing": client.post("/", json={}).status_code,
                }
        finally:
            server.should_exit = True
            thread.join(timeout=10)
            assert not thread.is_alive(), "loopback app server did not stop"


def run_probe(source_root, output, initial_token, failure):
    sys.addaudithook(prohibit_external_connections)
    expected = "synthetic-original-token" if initial_token == "present" else None
    if expected is None:
        os.environ.pop("MANAGED_AGENT_TOKEN", None)
    else:
        os.environ["MANAGED_AGENT_TOKEN"] = expected
    lifecycle = RoleTestLifecycle(failure)
    target = source_root / "agent-crewai/tests/test_main.py"
    code = pytest.main(
        [f"{target}::{ROLE_TEST}", "-q", "-p", "no:cacheprovider"],
        plugins=[lifecycle],
    )
    main = sys.modules["src.main"]
    result = {
        "sourceRoot": str(source_root),
        "initialToken": initial_token,
        "failure": failure,
        "pytestExit": int(code),
        "phases": lifecycle.phases,
        "roleAssertionPassed": lifecycle.role_assertion_passed,
        "restored": os.environ.get("MANAGED_AGENT_TOKEN") == expected,
        "leakedTestToken": os.environ.get("MANAGED_AGENT_TOKEN") == "test-token",
        "http": auth_statuses(main.app, main.TOKEN_HEADER),
    }
    output.write_text(json.dumps(result, indent=2) + "\n")
    assert code == (0 if failure == "none" else 1), result
    assert lifecycle.role_assertion_passed, result
    assert lifecycle.phases == {
        "setup": "passed",
        "call": "passed" if failure == "none" else "failed",
        "teardown": "passed",
    }, result
    assert result["restored"], "MANAGED_AGENT_TOKEN was not restored after pytest teardown"
    assert result["http"] == {
        "health": 200,
        "previous": 422 if initial_token == "present" else 401,
        "test": 401,
        "missing": 401,
    }, result


@pytest.mark.parametrize("initial_token", ["present", "absent"])
@pytest.mark.parametrize("failure", ["none", "assertion", "exception"])
def test_role_test_restores_token_after_pytest_teardown(tmp_path, initial_token, failure):
    output = tmp_path / "result.json"
    result = subprocess.run(
        [
            sys.executable, str(Path(__file__).resolve()),
            "--source-root", str(Path(__file__).resolve().parents[2]),
            "--output", str(output),
            "--initial-token", initial_token,
            "--failure", failure,
        ],
        cwd=tmp_path,
        env=isolated_environment(tmp_path),
        text=True,
        capture_output=True,
        timeout=90,
    )
    assert result.returncode == 0, result.stdout + result.stderr


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--initial-token", choices=["present", "absent"], required=True)
    parser.add_argument("--failure", choices=["none", "assertion", "exception"], default="none")
    arguments = parser.parse_args()
    run_probe(arguments.source_root.resolve(), arguments.output, arguments.initial_token, arguments.failure)
