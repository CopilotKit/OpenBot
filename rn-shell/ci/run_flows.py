#!/usr/bin/env python3
"""Runs the RN shell's Maestro flows one by one on the booted simulator or emulator.

  run_flows.py --platform ios|android --suite mock|real|demo --artifacts DIR [--private DIR] [--only a,b]

Each flow runs in its own folder under DIR/flows/<name>/ (its screenshots, Maestro's report and, on a
failure, a screenshot and the view hierarchy taken at that moment). results.json and SUMMARY.md are
written to DIR; every screenshot is also copied to DIR/shots/<flow>--<moment>.png.

The real-backend suite runs against https://my.open.bot. If Cloudflare's bot check appears, the flow
is marked skipped with its screenshot and nobody tries to get past it. The signed-in journey is
started by this script with the session cookie from OPENBOT_SHELL_TEST_SESSION, passed straight to
the launch command (never printed, never given to Maestro); its screenshots go to --private only.
"""
import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAESTRO = HERE.parent / "maestro"
APP_ID = "ai.openbot.rnshell"

ENV = {
    "BASE_A": "http://localhost:3010",
    "BASE_B": "http://localhost:3011",
    "BASE_502": "http://localhost:3014",
    "BASE_SILENT": "http://localhost:3013",
}

CLOUDFLARE = re.compile(r"Verify you are human|Performing security verification|verifies you are not a bot|Just a moment", re.I)

# name, flow file, platforms, before-hook, timeout seconds
MOCK = [
    # Shard 1: the hand-off first and alone (no retries: its flakiness is measured), then the flows
    # that start signed in with the mock's cookie; sign-out last (it ends the mock's session, as a
    # server does, until the next hand-off).
    ("handoff-sign-in", "flows/02-handoff-sign-in.yaml", "both", None, 120),
    ("first-screen", "flows/01-first-screen.yaml", "both", None, 120),
    ("tabs", "flows/03-tabs.yaml", "both", None, 180),
    ("keyboard-home", "flows/04-keyboard.yaml", "both", None, 180),
    ("keyboard-conversation", "flows/04b-keyboard-conversation.yaml", "both", None, 180),
    ("relaunch-signed-in", "flows/05-relaunch-signed-in.yaml", "both", None, 120),
    ("skeleton", "flows/08-skeleton.yaml", "both", None, 180),
    ("web-fallback", "flows/07-web-fallback.yaml", "both", None, 120),
    ("sign-out", "flows/06-sign-out.yaml", "both", None, 120),
    ("foreign-callback", "flows/18-foreign-callback.yaml", "android", None, 120),
    # Shard 2.
    ("lock-recovers", "flows/10-lock-recovers.yaml", "both", None, 120),
    ("lock-5xx", "flows/11-lock-5xx.yaml", "both", None, 120),
    ("lock-silent", "flows/12-lock-silent.yaml", "both", None, 120),
    ("process-death-before", "flows/15-process-death-a.yaml", "both", None, 120),
    ("process-death-after", "flows/16-process-death-b.yaml", "both", "kill-web-process", 120),
    ("lock-offline", "flows/09-lock-offline.yaml", "both", None, 120),
    ("stale-session", "flows/13-stale-session.yaml", "both", None, 120),
    ("header-probe", "flows/14-header-probe.yaml", "both", None, 120),
    ("dark", "flows/17-dark.yaml", "both", None, 120),
]
REAL = [
    ("real-first-screen-web-sign-in", "real/01-first-screen-web-sign-in.yaml", "both", None, 150),
    ("real-lock-unreachable", "real/02-lock-unreachable.yaml", "both", None, 120),
    ("real-signed-in-journey", "real/03-signed-in.yaml", "both", "launch-with-session", 150),
]
DEMO = [
    ("demo-tour", "demo/tour.yaml", "both", None, 300),
]
PRIVATE = {"real-signed-in-journey"}
# The mock suite in two shards that can run on two machines (each with its own mock stacks): the
# hand-off journey, which ends with sign-out, and the flows signed in with the mock's cookie.
SHARD_1 = {"handoff-sign-in", "first-screen", "tabs", "keyboard-home", "keyboard-conversation", "relaunch-signed-in", "skeleton", "web-fallback",
           "sign-out", "foreign-callback"}


def sh(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def device_screenshot(platform, path):
    try:
        if platform == "ios":
            sh(["xcrun", "simctl", "io", "booted", "screenshot", str(path)], timeout=30)
        else:
            with open(path, "wb") as out:
                subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=out, timeout=30)
    except Exception as error:  # noqa: BLE001
        print(f"  could not take a screenshot: {error}")


def hierarchy(folder):
    try:
        result = sh(["maestro", "hierarchy"], timeout=90)
        (folder / "hierarchy.json").write_text(result.stdout)
        return result.stdout
    except Exception:  # noqa: BLE001
        return ""


def kill_web_process(platform):
    if platform == "ios":
        # Simulator processes are host processes: the page's WebContent process dies like under memory pressure.
        result = sh(["pkill", "-9", "-f", "com.apple.WebKit.WebContent"])
        print(f"  killed WebContent (pkill exit {result.returncode})")
    else:
        listing = sh(["adb", "shell", "ps", "-A", "-o", "PID,NAME"]).stdout
        pids = [line.split()[0] for line in listing.splitlines() if "sandboxed_process" in line]
        for pid in pids:
            sh(["adb", "shell", "kill", "-9", pid])
        print(f"  killed {len(pids)} renderer process(es)")
    time.sleep(1)


def launch_with_session(platform):
    """Starts the app with the session cookie. The value goes to the launch command only."""
    secret = os.environ.get("OPENBOT_SHELL_TEST_SESSION", "")
    if not secret:
        return "no OPENBOT_SHELL_TEST_SESSION secret"
    if platform == "ios":
        sh(["xcrun", "simctl", "terminate", "booted", APP_ID])
        result = sh(["xcrun", "simctl", "launch", "booted", APP_ID,
                     "-openbot.reset", "1", "-openbot.test_session_cookie", secret, "-openbot.test_name", "real-journey"])
    else:
        command = (f"am start -S -W -n {APP_ID}/.MainActivity --es openbot.reset 1 "
                   f"--es openbot.test_name real-journey --es openbot.test_session_cookie {shlex.quote(secret)}")
        result = sh(["adb", "shell", command])
    del secret
    if result.returncode != 0:
        return "the app did not start with the session cookie"
    time.sleep(2)
    return None


def stop_maestro():
    """A flow killed at its deadline leaves Maestro's driver half-alive: stop it before the next flow."""
    sh(["pkill", "-f", "maestro.cli.AppKt"])
    sh(["pkill", "-f", "dev.mobile.maestro"])
    # Android: the driver Maestro leaves on the emulator; it starts again with the next flow.
    sh(["adb", "shell", "am", "force-stop", "dev.mobile.maestro"])
    sh(["adb", "shell", "am", "force-stop", "dev.mobile.maestro.test"])
    time.sleep(2)


def run_one(args, flow_dir, timeout):
    try:
        result = subprocess.run(args, cwd=flow_dir, capture_output=True, text=True, timeout=timeout)
        (flow_dir / "maestro.log").write_text(result.stdout + "\n" + result.stderr)
        if result.returncode == 0:
            return "passed", ""
        lines = [line for line in (result.stdout + result.stderr).splitlines() if line.strip()]
        failing = [line for line in lines if "FAILED" in line or "Assertion" in line or "not found" in line.lower() or "error" in line.lower()]
        return "failed", (failing or lines or ["maestro failed"])[-1][:300]
    except subprocess.TimeoutExpired as expired:
        out = expired.stdout or b""
        err = expired.stderr or b""
        text = (out.decode() if isinstance(out, bytes) else out) + "\n" + (err.decode() if isinstance(err, bytes) else err)
        (flow_dir / "maestro.log").write_text(text)
        stop_maestro()
        return "failed", f"timed out after {timeout} s"


def collect(flow_dir, shots_dir, name):
    shots = []
    for png in sorted(flow_dir.rglob("*.png")):
        if "debug" in png.parts and png.name.startswith("screenshot-"):
            continue
        target = shots_dir / f"{name}--{png.stem}.png"
        shutil.copyfile(png, target)
        shots.append(target.name)
    return shots


def run(platform, suite, artifacts, private, only, shard=0):
    plan = {"mock": MOCK, "real": REAL, "demo": DEMO}[suite]
    results = []
    for name, file, platforms, before, timeout in plan:
        if only and name not in only:
            continue
        if platforms != "both" and platforms != platform:
            continue
        if suite == "mock" and shard and ((name in SHARD_1) != (shard == 1)):
            continue
        base = private if name in PRIVATE and private else artifacts
        flow_dir = base / "flows" / name
        shots_dir = base / "shots"
        flow_dir.mkdir(parents=True, exist_ok=True)
        shots_dir.mkdir(parents=True, exist_ok=True)
        print(f"== {name}", flush=True)
        started = time.time()
        if before == "kill-web-process":
            kill_web_process(platform)
        elif before == "launch-with-session":
            problem = launch_with_session(platform)
            if problem:
                results.append({"name": name, "status": "skipped", "reason": problem, "seconds": 0, "shots": []})
                print(f"  skipped: {problem}")
                continue
        args = ["maestro", "test", str(MAESTRO / file), "--format", "junit", "--output", str(flow_dir / "report.xml"),
                "--test-output-dir", str(flow_dir), "--debug-output", str(flow_dir / "debug")]
        for key, value in ENV.items():
            args += ["-e", f"{key}={value}"]
        attempts = 0
        while True:
            attempts += 1
            status, reason = run_one(args, flow_dir, timeout)
            log_text = "".join(
                (flow_dir / name).read_text() for name in ("maestro.log", "report.xml") if (flow_dir / name).exists()
            )
            # Maestro's own driver dying (after a killed run) is not the app's failure: once more.
            if status == "failed" and attempts == 1 and re.search(r"DeviceServerDied|StatusRuntimeException: UNAVAILABLE|MaestroDriverStartupException|DriverTimeoutException|XCTestDriver.*(unreachable|failed)", log_text):
                print("  Maestro's driver died; running the flow again", flush=True)
                continue
            break
        if status == "failed":
            device_screenshot(platform, flow_dir / "failure.png")
            tree = hierarchy(flow_dir)
            if suite == "real" and CLOUDFLARE.search(tree):
                status, reason = "skipped", "Cloudflare's bot check appeared in the web view; not bypassed (see the screenshot)"
        seconds = round(time.time() - started, 1)
        shots = collect(flow_dir, shots_dir, name)
        print(f"  {status} in {seconds} s {reason}", flush=True)
        results.append({"name": name, "status": status, "reason": reason, "seconds": seconds, "shots": shots,
                        "private": name in PRIVATE})
    return results


def summarize(platform, suite, artifacts, results):
    lines = [f"## RN shell, {platform}, {suite} suite{os.environ.get('SHARD_LABEL', '')}", "", "| Flow | Result | Seconds | Note |", "| --- | --- | --- | --- |"]
    for item in results:
        note = item["reason"].replace("|", "/") if item["reason"] else ""
        where = " (screenshots private)" if item.get("private") else ""
        lines.append(f"| {item['name']} | {item['status']} | {item['seconds']} | {note}{where} |")
    counts = {key: sum(1 for item in results if item["status"] == key) for key in ("passed", "failed", "skipped")}
    lines += ["", f"{counts['passed']} passed, {counts['failed']} failed, {counts['skipped']} skipped.", ""]
    summary = artifacts / "SUMMARY.md"
    with summary.open("a") as out:
        out.write("\n".join(lines) + "\n")
    (artifacts / f"results-{suite}.json").write_text(json.dumps(results, indent=2))
    return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", required=True, choices=["ios", "android"])
    parser.add_argument("--suite", required=True, choices=["mock", "real", "demo"])
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--private", default="")
    parser.add_argument("--only", default="")
    parser.add_argument("--shard", type=int, default=0, help="mock suite: 1 or 2 (0 runs both)")
    options = parser.parse_args()
    artifacts = Path(options.artifacts)
    artifacts.mkdir(parents=True, exist_ok=True)
    private = Path(options.private) if options.private else None
    if private:
        private.mkdir(parents=True, exist_ok=True)
    only = {name for name in options.only.split(",") if name}
    results = run(options.platform, options.suite, artifacts, private, only, options.shard)
    counts = summarize(options.platform, options.suite, artifacts, results)
    sys.exit(1 if counts["failed"] else 0)


if __name__ == "__main__":
    main()
