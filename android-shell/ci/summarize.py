#!/usr/bin/env python3
"""Writes <artifacts>/SUMMARY.md from results.json, device.env and diagnostics.jsonl.

Usage: summarize.py <artifacts dir>
The same shape as the iOS shell's summary: environment, tests grouped by suite (with the build
variant each ran on), probe rows, the tests' notes, and a diagnostics overview. Nothing from the
tests that use a real account is read here (run_tests.py keeps their notes and diagnostics in the
private artifact).
"""
import collections
import json
import os
import sys

artifacts = sys.argv[1]
lines = ["# Android shell run\n"]


def read_env(path):
    values = {}
    if os.path.exists(path):
        for line in open(path, errors="replace"):
            if "=" in line:
                key, value = line.rstrip("\n").split("=", 1)
                values[key] = value
    return values


device = read_env(os.path.join(artifacts, "device.env"))
lines.append(f"- Emulator: API {device.get('API_LEVEL', '?')} (Android {device.get('ANDROID_RELEASE', '?')}), image {device.get('IMAGE', '?')}")
lines.append(f"- WebView: {device.get('WEBVIEW', '?')}")
lines.append(f"- Chrome (the Custom Tab): {device.get('CHROME', '?')}")
lines.append(f"- Keyboard: {device.get('IME', '?')}; screen {device.get('SCREEN', '?')}")
lines.append(f"- Builds: debug (hooks, cleartext to localhost) and releaseTest (R8-minified like release, no hooks; base URL, diagnostics and test name from intent extras); release APK checked for hook names")
lines.append("")

results = []
path = os.path.join(artifacts, "results.json")
if os.path.exists(path):
    results = json.load(open(path))

SUITES = [
    ("Suite 1: real backend (https://my.open.bot as deployed today)",
     lambda r: r["class"].startswith("RealBackend")),
    ("Suite 2: not deployed yet (mock stack + this branch's web build: shell mode, /conversations, the "
     "sign-in hand-off and the Account menu are not on my.open.bot yet)",
     lambda r: r["class"].startswith("ShellFlow")),
    ("Web view basics (local probe site, debug plain mode)", lambda r: r["class"].startswith("Probe")),
    ("Demo recording and videos", lambda r: r["class"] in ("DemoTourTest", "video")),
]
lines.append("## Tests\n")
if not results:
    lines.append("- no test results (did the build or the emulator fail? see the step logs)")
placed = set()
for title, belongs in SUITES + [("Other", lambda r: True)]:
    rows = [r for r in results if r["id"] not in placed and belongs(r)]
    if not rows:
        continue
    for r in rows:
        placed.add(r["id"])
    passed = sum(1 for r in rows if r["status"] == "passed")
    skipped = sum(1 for r in rows if r["status"] == "skipped")
    lines.append(f"### {title}: {passed} of {len(rows)} passed, {skipped} skipped\n")
    for r in rows:
        lines.append(f"- {r['id']} ({r['variant']} build, {r['seconds']} s): **{r['status']}**")
        if r.get("message") and r["status"] != "passed":
            lines.append(f"  - {r['message'][:400]}")
    lines.append("")

# How often Cloudflare's bot check stood in front of my.open.bot in this run.
real = [r for r in results if r["class"].startswith("RealBackend")]
stopped = [r for r in real if "Cloudflare" in r.get("message", "")]
probe_loads = [n for r in results for n in r.get("notes", []) if "challenge probe," in n]
shown = [n for n in probe_loads if "bot check shown true" in n]
lines.append("## Cloudflare's bot check\n")
lines.append(f"- real-backend tests stopped at it: {len(stopped)} of {len(real)} ({', '.join(r['test'] for r in stopped) or 'none'})")
lines.append(f"- loads observed by the challenge probe: {len(probe_loads)}, with the check shown: {len(shown)}")
for n in probe_loads:
    lines.append(f"  - {n[:300]}")
lines.append("")

lines.append("## Probe\n")
probe = [p for r in results for p in r.get("probe", [])]
summary = [p for p in probe if p.startswith("PROBE_SUMMARY")]
lines.append(f"- {summary[-1][len('PROBE_SUMMARY '):]}" if summary else "- no probe summary")
for row in dict.fromkeys(p for p in probe if p.startswith("PROBE_ROW")):
    lines.append(f"  - {row[len('PROBE_ROW '):]}")
persist = [p for p in probe if p.startswith("PERSIST_RESULT")]
if persist:
    lines.append(f"- persistence after a cold relaunch: {persist[-1][len('PERSIST_RESULT '):]}")
lines.append("")

notes = [n for r in results if not r.get("private") for n in r.get("notes", [])]
if notes:
    lines.append("## Notes from the tests\n")
    for note in dict.fromkeys(notes):
        lines.append(f"- {note[:500]}")
    lines.append("")

lines.append("## Diagnostics\n")
diag = os.path.join(artifacts, "diagnostics.jsonl")
if os.path.exists(diag):
    kinds = collections.Counter()
    notable, parity, configs, trails = [], [], [], {}
    for raw in open(diag, errors="replace"):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        kind = entry.get("kind", "?")
        kinds[kind] += 1
        test = str(entry.get("test", ""))
        short = test.split("-")[0]
        if kind == "launch":
            parity.append(f"{short}: WebView {entry.get('webViewPackage')}; user agent {entry.get('userAgent')}")
        if kind == "snapshot" and isinstance(entry.get("page"), dict):
            page = entry["page"]
            href = str(page.get("href", ""))
            if href.startswith("https://my.open.bot") or href.startswith("http://localhost:3010"):
                parity.append(f"{short}: {href.split('/')[2]} isSecureContext={page.get('isSecureContext')} "
                              f"session cookie visible to document.cookie={any('session_token' in n for n in page.get('documentCookieNames', []))} "
                              f"shell mark={page.get('nativeShellMark')} injected={page.get('injected')} bridge={page.get('bridge')} "
                              f"safe-area={page.get('safeAreaInsets')}")
        if kind == "cookie-store":
            names = [n for n in entry.get("names", []) if "session_token" in n]
            if names:
                parity.append(f"{short}: session cookie names in the store for {entry.get('url')}: {names}")
        if kind == "page-websocket":
            parity.append(f"{short}: websocket {entry.get('event')} {str(entry.get('url', '')).split('?')[0]}")
        if kind == "handoff-config":
            configs.append(f"{test}: status {entry.get('status')} -> {entry.get('mode')}" + (f" ({entry.get('error')})" if entry.get("error") else ""))
        if kind == "custom-tab":
            configs.append(f"{test}: custom tab {entry.get('result')} {entry.get('purpose', '')} browser={entry.get('browser', '')}")
        if test.startswith("testReal") and kind in ("navigation-action", "main-frame-start") and (entry.get("mainFrame", True)):
            url = str(entry.get("url", ""))
            trail = trails.setdefault(test, [])
            if url and (not trail or trail[-1] != url):
                trail.append(url)
        if kind in ("page-fetch-failed", "page-xhr-failed", "page-csp-violation", "page-console", "page-onerror",
                    "page-unhandledrejection", "navigation-error", "ssl-error", "render-process-gone", "bridge-rejected",
                    "feature-missing", "load-watchdog"):
            notable.append(raw.strip()[:400])
    lines.append("- entries by kind: " + ", ".join(f"{k} {v}" for k, v in sorted(kinds.items())))
    if notable:
        lines.append("- errors, warnings and failed requests (first 40):")
        lines.append("```")
        lines.extend(notable[:40])
        lines.append("```")
    if parity:
        lines.append("- production parity (WebView, user agent, cookies, secure context, websockets):")
        lines.extend(f"  - {item}" for item in list(dict.fromkeys(parity))[:60])
    if configs:
        lines.append("- hand-off config answers and Custom Tabs:")
        lines.extend(f"  - {c}" for c in list(dict.fromkeys(configs))[:60])
    for test, trail in trails.items():
        lines.append(f"- main-frame navigations in {test} (hosts visited):")
        lines.extend(f"  - {url}" for url in trail[:40])
else:
    lines.append("- no diagnostics.jsonl")

with open(os.path.join(artifacts, "SUMMARY.md"), "w") as f:
    f.write("\n".join(lines) + "\n")
print("\n".join(lines))
