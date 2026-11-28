#!/usr/bin/env python3
"""Runs the instrumented tests one `am instrument` call at a time, in order, and collects evidence.

Usage: run_tests.py <artifacts dir> <private artifacts dir> <repo root>

Environment: REAL_BACKEND_ONLY ("true" runs suite 1 only), GOOGLE_SIGN_IN ("true" lets the gated
Google test run), and the secrets OPENBOT_SHELL_TEST_SESSION, OPENBOT_SHELL_GOOGLE_EMAIL,
OPENBOT_SHELL_GOOGLE_PASSWORD, OPENBOT_SHELL_GOOGLE_TOTP_SECRET (passed to the tests as
instrumentation arguments; never printed).

One call per test means each test starts in a new app process: a test named `..._2_relaunch` is a
real cold relaunch of what the test before it left. Per test: logcat is cleared before and read
after (the app's diagnostics are its OPENBOT_DIAG lines), screenshots are pulled from
/data/local/tmp/openbot-shots, and the tests in RECORD are screen-recorded with `screenrecord`
(170 s segments, joined with ffmpeg: screenrecord stops at 180 s).
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time

artifacts, private, repo = (os.path.abspath(p) for p in sys.argv[1:4])
RUNNER = "ai.openbot.shell.test/androidx.test.runner.AndroidJUnitRunner"
PACKAGE = "ai.openbot.shell.test."
REAL_ONLY = os.environ.get("REAL_BACKEND_ONLY") == "true"
# "tests" (the test workflow: no recording) or "video" (the video workflow: VIDEO_PLAN demo|real|both).
MODE = os.environ.get("RUN_MODE", "tests")
VIDEO_PLAN = os.environ.get("VIDEO_PLAN", "both")
GOOGLE = os.environ.get("GOOGLE_SIGN_IN") == "true"
SECRET_ARGS = {
    "openbot_test_session": os.environ.get("OPENBOT_SHELL_TEST_SESSION", ""),
    "openbot_google_email": os.environ.get("OPENBOT_SHELL_GOOGLE_EMAIL", ""),
    "openbot_google_password": os.environ.get("OPENBOT_SHELL_GOOGLE_PASSWORD", ""),
    "openbot_google_totp_secret": os.environ.get("OPENBOT_SHELL_GOOGLE_TOTP_SECRET", ""),
}
# Tests that use a real account: everything they leave goes to the private artifact only.
PRIVATE_TESTS = (
    "testRealSignedInJourneyWithSessionCookie",
    "testRealGoogleSignInInCustomTab",
    "testRealGoogleSignInInWebViewAndJourney",
)

SUITE1_RELEASE = [
    "RealBackendReleaseTest#testRealFirstScreenAndWebSignIn",
    "RealBackendReleaseTest#testRealLockScreenWhenBackendUnreachable",
    "RealBackendReleaseTest#testRealGoogleSignInInWebViewAndJourney",
]
SUITE1_DEBUG = [
    "RealBackendDebugTest#testLoadsHostedWebApp",
    "RealBackendDebugTest#testRealSignInPathInCustomTab",
    "RealBackendDebugTest#testRealChallengeProbe",
    "RealBackendDebugTest#testRealChallengeProbe_2_relaunch",
    "RealBackendDebugTest#testRealGoogleSignInInCustomTab",
    "RealBackendDebugTest#testRealSignedInJourneyWithSessionCookie",
    "RealBackendDebugTest#testRealSignedInJourneyWithSessionCookie_2_relaunch",
]
PROBE = [
    "ProbeTest#testProbeSite",
    "ProbeTest#testWebViewIdentity",
    "ProbeTest#testOfflineShowsRetry",
    "ProbeTest#testWatchdogCatchesSilentLoad",
    "ProbeTest#testSessionSurvivesRelaunch",
    "ProbeTest#testSessionSurvivesRelaunch_2_relaunch",
    "ProbeTest#testBlankWindowOpenKeepsThePage",
    "ProbeTest#testEnterRequestHeaders",
    "ProbeTest#testBackWithoutCanGoBackUsesHistory",
    "SelfHostedTest#testFieldOnlyWhenAsked",
    "SelfHostedTest#testRefusedAddressesStayOnCloud",
    "SelfHostedTest#testSelfHostedSignInAndBackToCloud",
    "SelfHostedTest#testLockNamesTheServer",
]
SUITE2 = [
    "ShellFlowTest#testFirstScreenIsNative",
    "ShellFlowTest#testNativeSignInThroughCustomTab",
    "ShellFlowTest#testNativeSignInThroughCustomTab_2_relaunch",
    "ShellFlowTest#testTabsRouteTheWebView",
    "ShellFlowTest#testSignedOutByServerReturnsToNativeSignIn",
    "ShellFlowTest#testSignOutFromAccountMenu",
    "ShellFlowTest#testSignInClearsALeftoverSession",
    "ShellFlowTest#testWellFormedForgedTicketDoesNotSignIn",
    "ShellFlowTest#testOpenTheAppIntentIsTheCallback",
    "NavigationTest#testChatsConversationBackKeepsTheList",
    "NavigationTest#testBotsConversationKeepsBots",
    "NavigationTest#testTabsRememberWhereTheyWereLeft",
    "NavigationTest#testBackAtARootLeavesTheApp",
    "NavigationTest#testSettingsHasBack",
    "ShellFlowTest#testFallbackToWebSignIn",
    "ShellFlowTest#testOfflineLock",
    "ShellFlowTest#testKeyboardHidesTabBar",
    "ShellFlowTest#testResumeFromBackground",
    "ShellFlowTest#testLoadingSkeleton",
    "ShellFlowTest#testLockLiftsWhenServerComesBack",
    "RenderingTest#testBotsPageRendering",
    "HardeningTest#testLargestFontScale",
    "HardeningTest#testAccessibilityLabels",
    "HardeningTest#testTabletSizeAndRotation",
    "HardeningTest#testRendererKilledRecovers",
    "HardeningTest#testStatusBarIconsOnLightScreens",
]
DEMO = ["DemoTourTest#testDemoTour"]
# Recordings (video mode only): (first test, last test, file, private?)
RECORD = [
    ("RealBackendDebugTest#testRealSignedInJourneyWithSessionCookie",
     "RealBackendDebugTest#testRealSignedInJourneyWithSessionCookie_2_relaunch", "real-journey.mp4", True),
    ("RealBackendReleaseTest#testRealGoogleSignInInWebViewAndJourney",
     "RealBackendReleaseTest#testRealGoogleSignInInWebViewAndJourney", "real-google-webview.mp4", True),
    ("RealBackendDebugTest#testRealGoogleSignInInCustomTab",
     "RealBackendDebugTest#testRealGoogleSignInInCustomTab", "real-google-custom-tab.mp4", True),
    ("DemoTourTest#testDemoTour", "DemoTourTest#testDemoTour", "demo-tour.mp4", False),
    ("SelfHostedTest#testClipSelfHostedThenCloud", "SelfHostedTest#testClipSelfHostedThenCloud", "self-hosted.mp4", False),
]
VIDEO_REAL = [
    "RealBackendDebugTest#testRealSignedInJourneyWithSessionCookie",
    "RealBackendDebugTest#testRealSignedInJourneyWithSessionCookie_2_relaunch",
]
# Exactly 1 Google attempt per run: the app's own path on production (the web sign-in in the
# WebView, as production has no hand-off). The Custom Tab attempt is not part of a recording run.
VIDEO_REAL_GOOGLE = [
    "RealBackendReleaseTest#testRealGoogleSignInInWebViewAndJourney",
]
LOG_TAGS = ("OPENBOT_DIAG", "SHELL_NOTE", "SHELL_PROBE", "TestRunner", "AndroidRuntime", "chromium", "cr_", "WebView")
PER_TEST_S = int(os.environ.get("PER_TEST_SECONDS", "300"))
# The whole run's budget (the workflow step is capped at 25 minutes): no test starts after this.
BUDGET_S = int(os.environ.get("TEST_BUDGET_SECONDS", "1380"))
STATUS = {"0": "passed", "-1": "failed", "-2": "failed", "-3": "skipped", "-4": "skipped"}


def adb(*args, timeout=120, check=False):
    try:
        return subprocess.run(["adb", *args], capture_output=True, text=True, timeout=timeout, check=check)
    except subprocess.TimeoutExpired:
        print(f"    adb {' '.join(args)[:60]} timed out", flush=True)
        return subprocess.CompletedProcess(args, 1, "", "timeout")


def is_private(test_id):
    return any(name in test_id for name in PRIVATE_TESTS)


class Recorder:
    """screenrecord in 170 s segments until stopped (screenrecord's own limit is 180 s)."""

    def __init__(self, name):
        self.name = name
        self.stop_flag = threading.Event()
        self.segments = []
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.started = time.time()

    def start(self):
        adb("shell", "rm -f /data/local/tmp/rec-*.mp4")
        # A clean home screen in the first frame: no launcher menu, no shade.
        adb("shell", "input keyevent KEYCODE_HOME")
        adb("shell", "am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS")
        time.sleep(2)
        self.thread.start()
        time.sleep(2)

    def run(self):
        index = 0
        while not self.stop_flag.is_set():
            path = f"/data/local/tmp/rec-{index:02d}.mp4"
            self.segments.append(path)
            subprocess.run(["adb", "shell", "screenrecord", "--bit-rate", "6000000", "--time-limit", "170", path],
                           capture_output=True, text=True)
            index += 1

    def stop(self, dest_dir):
        self.stop_flag.set()
        time.sleep(1)
        adb("shell", "pkill -INT screenrecord")
        self.thread.join(timeout=30)
        time.sleep(2)
        os.makedirs(dest_dir, exist_ok=True)
        local = []
        for segment in self.segments:
            target = os.path.join(dest_dir, os.path.basename(segment))
            if adb("pull", segment, target, timeout=60).returncode == 0 and os.path.getsize(target) > 0:
                local.append(target)
        dest = os.path.join(dest_dir, self.name)
        if len(local) == 1:
            shutil.move(local[0], dest)
        elif local:
            listing = os.path.join(dest_dir, "segments.txt")
            with open(listing, "w") as f:
                f.writelines(f"file '{os.path.basename(p)}'\n" for p in local)
            # Re-encoded: screenrecord's segments do not join cleanly with stream copy.
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listing,
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", dest],
                           cwd=dest_dir)
            for p in local + [listing]:
                if os.path.exists(p):
                    os.remove(p)
        adb("shell", "rm -f /data/local/tmp/rec-*.mp4")
        return dest if os.path.exists(dest) else None


def video_seconds(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def system_dialog_guard():
    """A recording never starts over a system "isn't responding" or crash dialog: the run fails."""
    for attempt in range(3):
        windows = adb("shell", "dumpsys window windows").stdout
        bad = [line.strip() for line in windows.splitlines()
               if "Application Not Responding" in line or "Application Error" in line or "AppNotResponding" in line]
        if not bad:
            return
        print(f"  system dialog on screen: {bad[:2]}; closing it", flush=True)
        adb("shell", "am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS")
        adb("shell", "input keyevent KEYCODE_BACK")
        time.sleep(5)
    print("::error::a system dialog is on screen; not recording through it")
    sys.exit(1)


def trim_and_copy(path, recording_started, instrument_log):
    """Trims to the test's own video marks (1 s of margin) and writes a 600-px-wide H.264 copy."""
    marks = ""
    for name in (instrument_log, os.path.join(os.path.dirname(instrument_log), "logcat-app.txt")):
        if os.path.exists(name):
            marks += open(name, errors="replace").read()
    starts = [float(x) for x in re.findall(r"video-mark start ([0-9.]+)", marks)]
    ends = [float(x) for x in re.findall(r"video-mark end ([0-9.]+)", marks)]
    if starts and ends:
        start = max(0.0, starts[-1] - recording_started - 1.0)
        # The last start mark and the last end mark after it.
        end = max(e for e in ends) - recording_started + 1.0
        if end > start + 5:
            trimmed = path[:-4] + ".trimmed.mp4"
            result = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-ss", f"{start:.2f}", "-t",
                                     f"{end - start:.2f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                                     "-pix_fmt", "yuv420p", "-an", trimmed])
            if result.returncode == 0 and os.path.exists(trimmed):
                os.replace(trimmed, path)
                print(f"  trimmed {os.path.basename(path)} to {end - start:.1f} s", flush=True)
    small = path[:-4] + "-600.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-vf", "scale=600:-2", "-c:v", "libx264",
                    "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-an", small])


class LateStack:
    """Starts OpenBot on 3012 about 8 s after testLockLiftsWhenServerComesBack touches its trigger."""

    def __init__(self):
        self.process = None
        self.thread = threading.Thread(target=self.watch, daemon=True)
        self.done = threading.Event()

    def watch(self):
        deadline = time.time() + 300
        while time.time() < deadline and not self.done.is_set():
            if "openbot-late-stack" in adb("shell", "ls /data/local/tmp").stdout:
                time.sleep(8)
                env = dict(os.environ, APP_PORT="3012", SERVER_PORT="3001")
                log = open(os.path.join(artifacts, "app-late.log"), "w")
                self.process = subprocess.Popen(["bun", "app/serve.ts"], cwd=repo, env=env, stdout=log, stderr=log)
                print("    late stack started on 3012", flush=True)
                return
            time.sleep(1)

    def stop(self):
        self.done.set()
        if self.process:
            self.process.terminate()
        adb("shell", "rm -f /data/local/tmp/openbot-late-stack")


def emulator_alive():
    try:
        out = subprocess.run(["adb", "shell", "echo", "alive"], capture_output=True, text=True, timeout=20).stdout
        return "alive" in out
    except subprocess.TimeoutExpired:
        return False


def ensure_emulator():
    """A known state before a run: the emulator answering (restarted if frozen or gone), no leftover
    recording, the app stopped with its data cleared."""
    if not emulator_alive():
        print("  the emulator does not answer: restarting it", flush=True)
        subprocess.run(["pkill", "-9", "-f", "qemu-system"], capture_output=True)
        subprocess.run(["adb", "kill-server"], capture_output=True, timeout=30)
        here = os.path.dirname(os.path.abspath(__file__))
        try:
            subprocess.run(["bash", os.path.join(here, "emulator.sh"), "boot"], timeout=200)
            subprocess.run(["bash", os.path.join(here, "emulator.sh"), "prepare"], timeout=120)
            for apk in ("debug/app-debug.apk", "androidTest/debug/app-debug-androidTest.apk"):
                adb("install", "-r", "-g", os.path.join(here, "..", "app/build/outputs/apk", apk), timeout=120)
        except subprocess.TimeoutExpired:
            print("  the emulator did not come back", flush=True)
    adb("shell", "pkill -INT screenrecord", timeout=20)
    adb("shell", "am force-stop ai.openbot.shell", timeout=20)
    adb("shell", "input keyevent KEYCODE_HOME", timeout=20)


def not_run(test_id, results, why):
    results.append({"id": test_id, "test": test_id.split("#")[-1], "class": test_id.split("#")[0], "status": "failed",
                    "message": f"not run: {why}", "variant": "releaseTest" if test_id.startswith("RealBackendRelease") else "debug",
                    "seconds": 0, "private": is_private(test_id), "notes": [], "probe": []})
    print(f"  not run  {test_id}: {why}", flush=True)


def run_one(test_id, results, logs):
    short = test_id.split("#")[-1]
    extra = []
    for key, value in SECRET_ARGS.items():
        if value:
            extra += ["-e", key, shlex.quote(value)]
    extra += ["-e", "google_sign_in", "true" if GOOGLE else "false"]
    if MODE == "video":
        extra += ["-e", "video", "1"]
    late = None
    if short == "testLockLiftsWhenServerComesBack":
        extra += ["-e", "late_stack", "1"]
        late = LateStack()
        late.thread.start()
    adb("logcat", "-c", timeout=20)
    adb("shell", "rm -rf /data/local/tmp/openbot-shots; mkdir -p /data/local/tmp/openbot-shots", timeout=20)
    started = time.time()
    command = "am instrument -w -r -e class " + PACKAGE + test_id + " " + " ".join(extra) + " " + RUNNER
    print(f"  starting {test_id}", flush=True)
    # Streamed: the tests' notes (status code 2) are printed as they come, private tests' only as
    # step markers, so a hang shows its last step in the job log.
    process = subprocess.Popen(["adb", "shell", command], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []
    last_note = [""]

    def pump():
        for line in process.stdout:
            lines.append(line)
            if "shell_note=" in line:
                note = line.split("shell_note=", 1)[1].strip()
                for value in SECRET_ARGS.values():
                    if value:
                        note = note.replace(value, "***")
                last_note[0] = note
                if not is_private(test_id) or ": step " in note:
                    print(f"    | {note[:300]}", flush=True)

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    try:
        process.wait(timeout=PER_TEST_S)
    except subprocess.TimeoutExpired:
        process.kill()
        lines.append(f"\nINSTRUMENTATION_STATUS: stack=runner: the test ran past {PER_TEST_S} s and was stopped; last note: {last_note[0]}\nINSTRUMENTATION_STATUS_CODE: -2\n")
        print(f"    the test ran past {PER_TEST_S} s; last note: {last_note[0][:300]}", flush=True)
        adb("shell", "screencap -p /data/local/tmp/openbot-shots/" + test_id.split("#")[-1] + "--runner-timeout.png", timeout=20)
        adb("shell", "am force-stop ai.openbot.shell", timeout=20)
    reader.join(timeout=5)
    out = "".join(lines)
    seconds = round(time.time() - started)
    if late:
        late.stop()
    # The secrets never reach the log: am instrument does not echo its arguments, and to be sure:
    for value in SECRET_ARGS.values():
        if value:
            out = out.replace(value, "***")
    codes = re.findall(r"INSTRUMENTATION_STATUS_CODE: (-?\d+)", out)
    final = [c for c in codes if c not in ("1", "2")]
    status = STATUS.get(final[-1], "failed") if final else ("failed" if "Process crashed" in out or "FAILURES" in out else "unknown")
    stack = ""
    match = re.search(r"INSTRUMENTATION_STATUS: stack=(.*?)(?=INSTRUMENTATION_STATUS(_CODE)?:)", out, re.S)
    if match:
        stack = match.group(1).strip()
    if "Process crashed" in out:
        stack = (stack + "\nthe app process crashed").strip()
    message = stack.splitlines()[0] if stack else ""
    if status == "skipped" and stack:
        message = re.sub(r"^org\.junit\.AssumptionViolatedException: ", "", stack.splitlines()[0])
    # Evidence: logcat and screenshots, private tests apart.
    target = private if is_private(test_id) else artifacts
    try:
        log = adb("logcat", "-d", "-v", "threadtime", timeout=40).stdout
    except subprocess.TimeoutExpired:
        log = ""
        print("    logcat did not answer in 5 minutes", flush=True)
    for value in SECRET_ARGS.values():
        if value:
            log = log.replace(value, "***")
    kept = [line for line in log.splitlines() if any(tag in line for tag in LOG_TAGS) or "ai.openbot.shell" in line]
    with open(os.path.join(target, "logcat-app.txt"), "a") as f:
        f.write(f"===== {test_id} =====\n" + "\n".join(kept) + "\n")
    with open(os.path.join(target, "diagnostics.jsonl"), "a") as f:
        for line in kept:
            index = line.find("OPENBOT_DIAG: ")
            if index >= 0:
                f.write(line[index + len("OPENBOT_DIAG: "):] + "\n")
    notes = [re.sub(r"^.*?SHELL_NOTE\s*:\s*", "", line) for line in kept if "SHELL_NOTE" in line]
    probe = [re.sub(r"^.*?SHELL_PROBE\s*:\s*", "", line) for line in kept if "SHELL_PROBE" in line]
    raw = os.path.join(target, "raw-shots")
    os.makedirs(raw, exist_ok=True)
    adb("pull", "/data/local/tmp/openbot-shots/.", raw, timeout=60)
    with open(os.path.join(target, "instrument.log"), "a") as f:
        f.write(f"===== {test_id} ({seconds} s) =====\n{out}\n")
    variant = "releaseTest" if test_id.startswith("RealBackendReleaseTest") else "debug"
    results.append({"id": test_id, "test": short, "class": test_id.split("#")[0], "status": status,
                    "message": message[:600], "variant": variant, "seconds": seconds,
                    "private": is_private(test_id), "notes": [] if is_private(test_id) else notes, "probe": probe})
    logs.append(out)
    print(f"  {status:8} {test_id} ({seconds} s) {message[:200]}", flush=True)
    return status


def main():
    os.makedirs(artifacts, exist_ok=True)
    os.makedirs(private, exist_ok=True)
    if MODE == "video":
        ensure_emulator()
        plan = []
        # The demo (mock, deterministic) first, then the real journey.
        if VIDEO_PLAN in ("demo", "both"):
            plan += DEMO
        if VIDEO_PLAN == "self-hosted":
            plan += ["SelfHostedTest#testClipSelfHostedThenCloud"]
        after_release = -1
        if VIDEO_PLAN in ("real", "both"):
            if GOOGLE:
                after_release = len(plan) + 1
            plan += VIDEO_REAL_GOOGLE if GOOGLE else VIDEO_REAL
    else:
        # The mock suite first (it matters most and needs no outside network), then the probe,
        # then the real backend. The release-like build leaves before the hand-off tests only if it
        # is installed, so its tests run last.
        # SHARD: "mock" (suite 2, rendering, hardening) or "other" (probe, suite 1) on two emulators
        # in parallel; unset runs everything.
        shard = os.environ.get("SHARD", "")
        plan = []
        if shard in ("", "mock") and not REAL_ONLY:
            plan += SUITE2
        if shard in ("", "other"):
            if not REAL_ONLY:
                plan += PROBE
            plan += SUITE1_DEBUG + SUITE1_RELEASE
        after_release = -1
    results, logs = [], []
    recorders = {}
    recorded_status = "unknown"
    run_started = time.time()
    for index, test_id in enumerate(plan):
        if time.time() - run_started > BUDGET_S:
            not_run(test_id, results, f"the run's {BUDGET_S // 60}-minute budget was spent")
            continue
        if not emulator_alive():
            qemu = subprocess.run(["pgrep", "-fa", "qemu-system"], capture_output=True, text=True).stdout.strip()
            not_run(test_id, results, "the emulator stopped answering adb (" + ("its process is still running: frozen" if qemu else "its process is gone") + ")")
            continue
        if test_id.startswith("RealBackendReleaseTest") and "releasetest" not in adb("shell", "pm list packages ai.openbot.shell.releasetest").stdout:
            here = os.path.dirname(os.path.abspath(__file__))
            adb("install", "-r", "-g", os.path.join(here, "..", "app/build/outputs/apk/releaseTest/app-releaseTest.apk"), timeout=120)
        if index == after_release:
            # Two apps claiming openbotshell:// would make Chrome ask which one: the release-like
            # build leaves before the hand-off tests.
            adb("uninstall", "ai.openbot.shell.releasetest")
        if test_id == "RealBackendDebugTest#testRealGoogleSignInInCustomTab" and GOOGLE:
            # One Google attempt per run: the Custom Tab only when the WebView was refused.
            webview = [r for r in results if r["test"] == "testRealGoogleSignInInWebViewAndJourney"]
            if webview and not (webview[-1]["status"] == "skipped" and "refused" in webview[-1]["message"]):
                results.append({"id": test_id, "test": test_id.split("#")[-1], "class": "RealBackendDebugTest",
                                "status": "skipped", "message": "not run: the WebView attempt was not refused by Google (one attempt per run)",
                                "variant": "debug", "seconds": 0, "private": True, "notes": [], "probe": []})
                continue
        if MODE == "video":
            for first, last, name, secret in RECORD:
                if test_id == first:
                    system_dialog_guard()
                    recorders[name] = Recorder(name)
                    recorders[name].start()
        status = run_one(test_id, results, logs)
        for first, last, name, secret in RECORD:
            if test_id == first:
                recorded_status = status
            if test_id == last and name in recorders:
                recorder = recorders.pop(name)
                dest = recorder.stop(os.path.join(private if secret else artifacts, "video"))
                if dest:
                    trim_and_copy(dest, recorder.started, os.path.join(private if secret else artifacts, "instrument.log"))
                length = video_seconds(dest) if dest else 0.0
                print(f"  video {name}: {length:.1f} s", flush=True)
                if recorded_status == "skipped":
                    # Nothing to show: the test skipped itself (no secret, gate off, backend down).
                    if dest and os.path.exists(dest):
                        os.remove(dest)
                    video_status, message = "skipped", "the recorded test skipped itself"
                else:
                    video_status = "passed" if length >= 30 else "failed"
                    message = f"{length:.1f} s recorded" + ("" if length >= 30 else " (under 30 s)")
                results.append({"id": f"video:{name}", "test": name, "class": "video", "variant": "debug",
                                "status": video_status, "seconds": round(length), "message": message,
                                "private": secret, "notes": [], "probe": []})
    # Several runs (one per recording step) add to the same results file.
    path = os.path.join(artifacts, "results.json")
    earlier = json.load(open(path)) if os.path.exists(path) else []
    with open(path, "w") as f:
        json.dump(earlier + results, f, indent=2)
    failed = [r for r in results if r["status"] not in ("passed", "skipped")]
    print(f"{len(results)} results, {len(failed)} not passed or skipped")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
