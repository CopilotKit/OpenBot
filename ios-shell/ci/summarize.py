#!/usr/bin/env python3
"""Gives exported xcresult attachments readable names and writes artifacts/SUMMARY.md.

Usage: summarize.py <artifacts dir> <xcresult path> <xcodebuild.log>
Every input may be missing: the summary says so instead of failing.
"""
import collections
import json
import os
import re
import shutil
import subprocess
import sys

artifacts, xcresult, log_path = sys.argv[1:4]
# Tests that use a real account: their diagnostics never reach the summary (collect_shots.py moves
# them out of the general artifact).
PRIVATE_TESTS = ("testRealGoogleSignInInWebViewAndJourney", "testRealGoogleSignInInSystemSheet", "testRealSignedInJourneyWithSessionCookie")


def private_entry(entry):
    test = str(entry.get("test", ""))
    return any(test == name or test.startswith(name + "-") for name in PRIVATE_TESTS)

attachments = os.path.join(artifacts, "attachments")
lines = []


def safe(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "attachment"


# 1. Readable attachment names, from the manifest that `xcresulttool export attachments` writes
#    (one folder per result bundle under attachments/), copied to attachments/<test>--<name>.
for root, _dirs, files in os.walk(attachments):
    if "manifest.json" not in files:
        continue
    try:
        with open(os.path.join(root, "manifest.json")) as f:
            manifest = json.load(f)
        for test in manifest:
            test_name = safe(test.get("testIdentifier", "test").split("/")[-1])
            for item in test.get("attachments", []):
                src = os.path.join(root, item.get("exportedFileName", ""))
                if not os.path.isfile(src):
                    continue
                human = item.get("suggestedHumanReadableName") or os.path.basename(src)
                dest = os.path.join(attachments, f"{test_name}--{safe(human)}")
                if not os.path.splitext(dest)[1]:
                    dest += os.path.splitext(src)[1]
                shutil.copyfile(src, dest)
    except Exception as error:  # the summary still gets written
        print(f"could not rename attachments in {root}: {error}")

# 2. Environment.
lines.append("# iOS shell run\n")
lines.append(f"- Xcode: {os.environ.get('XCODE_VERSION', 'unknown')}")
lines.append(f"- Simulator: {os.environ.get('SIM_NAME', 'unknown')} ({os.environ.get('SIM_RUNTIME', 'unknown')})")
lines.append("")

# 3. Per-test results: xcresulttool first, the log as a fallback.
results = []
for bundle in [b for b in xcresult.split(":") if b]:
    build = "Release" if os.path.basename(bundle).startswith("Release-") else "Debug"
    try:
        raw = subprocess.run(["xcrun", "xcresulttool", "get", "test-results", "tests", "--path", bundle],
                             capture_output=True, text=True, timeout=120)
        if raw.returncode == 0:
            def walk(node, suite):
                if node.get("nodeType") == "Test Suite":
                    suite = node.get("name", suite)
                if node.get("nodeType") == "Test Case":
                    notes = [c.get("name", "") for c in node.get("children", [])
                             if c.get("nodeType") in ("Failure Message", "Skip Message", "Runtime Warning")]
                    results.append((suite, node.get("name", "?"), node.get("result", "?"), notes, build))
                for child in node.get("children", []):
                    walk(child, suite)
            for node in json.loads(raw.stdout).get("testNodes", []):
                walk(node, "?")
    except Exception as error:
        print(f"xcresulttool failed on {bundle}: {error}")

log = ""
for one_log in [p for p in log_path.split(":") if p]:
    if os.path.exists(one_log):
        with open(one_log, errors="replace") as f:
            log += f.read() + "\n"
if not results and log:
    for match in re.finditer(r"Test [Cc]ase '-\[\S+?\.(\w+) (\w+)\]' (passed|failed|skipped)", log):
        results.append((match.group(1), match.group(2), match.group(3), [], "?"))

SUITES = [
    ("Suite 1: real backend (https://my.open.bot as deployed today)",
     lambda suite, name: suite.startswith("RealBackend") or name.startswith("testLoadsHostedWebApp")),
    ("Suite 2: not deployed yet (mock stack + this branch's web build: shell mode, /conversations, "
     "the sign-in hand-off and the Account menu are not on my.open.bot yet; web draft PR 2360 and the "
     "server hand-off draft PR carry them)",
     lambda suite, name: suite.startswith("ShellFlow")),
    ("Web view basics (local probe site)", lambda suite, name: suite.startswith("ShellUITests")),
    ("Demo recording", lambda suite, name: suite.startswith("DemoTour")),
    ("Unit tests (pure sign-in logic)", lambda suite, name: suite.startswith("HandoffConfig")),
]
lines.append("## Tests\n")
if not results:
    lines.append("- no test results found (did the build fail? see xcodebuild.log)")
placed = set()
for title, belongs in SUITES + [("Other", lambda suite, name: True)]:
    rows = [r for r in results if id(r) not in placed and belongs(r[0], r[1])]
    if not rows:
        continue
    for r in rows:
        placed.add(id(r))
    passed = sum(1 for r in rows if r[2].lower() == "passed")
    skipped = sum(1 for r in rows if r[2].lower() == "skipped")
    lines.append(f"### {title}: {passed} of {len(rows)} passed, {skipped} skipped\n")
    for suite, name, result, notes, build in rows:
        lines.append(f"- {suite}.{name} ({build} build): **{result}**")
        for note in notes:
            lines.append(f"  - {note}")
    lines.append("")

# 4. Probe and persistence lines that the UI tests print.
lines.append("## Probe\n")
probe = re.findall(r"PROBE_SUMMARY (.*)", log)
lines.append(f"- {probe[-1]}" if probe else "- no probe summary in the log")
for row in dict.fromkeys(re.findall(r"PROBE_ROW (.*)", log)):
    if re.match(r"^[a-z-]+: (pass|fail|skip|info) ", row):
        lines.append(f"  - {row}")
persist = re.findall(r"PERSIST_RESULT (.*)", log)
if persist:
    lines.append(f"- persistence after relaunch: {persist[-1]}")
lines.append("")

# 4b. Notes the UI tests print.
notes = re.findall(r"SHELL_NOTE (.*)", log)
if notes:
    lines.append("## Notes from the tests\n")
    for note in dict.fromkeys(notes):
        lines.append(f"- {note[:500]}")
    lines.append("")

# 5. Diagnostics overview.
diag_path = os.path.join(artifacts, "diagnostics.jsonl")
lines.append("## Diagnostics\n")
if os.path.exists(diag_path):
    kinds = collections.Counter()
    notable = []
    probes = []
    production_trails = {}
    parity = []
    session_names = ("better-auth.session_token", "__Secure-better-auth.session_token")
    with open(diag_path, errors="replace") as f:
        for raw_line in f:
            try:
                entry = json.loads(raw_line)
            except ValueError:
                continue
            if private_entry(entry):
                continue
            kinds[entry.get("kind", "?")] += 1
            test = str(entry.get("test", ""))
            short = test.split("-")[0]
            if entry.get("kind") == "cookie-store":
                for cookie in entry.get("cookies", []):
                    if cookie.get("name") in session_names:
                        parity.append(f"{short}: cookie {cookie.get('name')} on {cookie.get('domain')} secure={cookie.get('isSecure')} "
                                      f"httpOnly={cookie.get('isHTTPOnly')} sameSite={cookie.get('sameSite')} sessionOnly={cookie.get('isSessionOnly')}")
            if entry.get("kind") == "snapshot" and isinstance(entry.get("page"), dict):
                page = entry["page"]
                href = str(page.get("href", ""))
                if href.startswith("https://shell-test") or href.startswith("https://my.open.bot"):
                    visible = [n for n in page.get("documentCookieNames", []) if "session_token" in n]
                    parity.append(f"{short}: {href.split('/')[2]} isSecureContext={page.get('isSecureContext')} "
                                  f"session cookie visible to document.cookie={bool(visible)}")
                    parity.append(f"{short}: user agent {page.get('userAgent')}")
            if entry.get("kind") == "page-websocket":
                parity.append(f"{short}: websocket {entry.get('event')} {str(entry.get('url', '')).split('?')[0]}")
            if entry.get("kind") in ("handoff-probe", "handoff-config"):
                probes.append(f"{test}: status {entry.get('status')} {entry.get('mode', entry.get('supported'))}")
            if test.startswith("testReal") and entry.get("kind") == "navigation-action" and entry.get("mainFrame"):
                url = str(entry.get("url", ""))
                trail = production_trails.setdefault(test, [])
                if not trail or trail[-1] != url:
                    trail.append(url)
            if entry.get("kind") in ("page-fetch-failed", "page-xhr-failed", "page-csp-violation",
                                     "page-console", "page-onerror", "page-unhandledrejection",
                                     "navigation-error", "page-resource-error"):
                notable.append(raw_line.strip()[:400])
    lines.append("- entries by kind: " + ", ".join(f"{k} {v}" for k, v in sorted(kinds.items())))
    if notable:
        lines.append("- errors, warnings and failed requests (first 40):")
        lines.append("```")
        lines.extend(notable[:40])
        lines.append("```")
    if parity:
        lines.append("- production parity (session cookies as stored, secure context, document.cookie, websockets):")
        lines.extend(f"  - {item}" for item in list(dict.fromkeys(parity))[:60])
    if probes:
        lines.append("- hand-off probes:")
        lines.extend(f"  - {probe}" for probe in probes)
    for test, trail in production_trails.items():
        lines.append(f"- main-frame navigations in {test}:")
        lines.extend(f"  - {url}" for url in trail[:40])
else:
    lines.append("- diagnostics.jsonl was not found in the app container")

with open(os.path.join(artifacts, "SUMMARY.md"), "w") as f:
    f.write("\n".join(lines) + "\n")
print("\n".join(lines))
