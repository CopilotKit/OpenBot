#!/usr/bin/env python3
"""Builds the small screenshot set and keeps a real account's material apart.

Usage: collect_shots.py <artifacts dir>

Run after summarize.py (which gives attachments readable names, <test>--<moment>.<ext>).

- Moves everything from the tests that use a real account (PRIVATE_TESTS) out of <artifacts> into
  <artifacts>/../private-artifacts: their attachments, their diagnostics lines and their app log
  lines. What stays in <artifacts> is fit for the general artifact and the public CI log.
- Writes <artifacts>/shots: every remaining screenshot downscaled to JPEG with sips
  (<test>--<moment>.jpg), the text attachments, SUMMARY.md and diagnostics.jsonl.
- Writes <artifacts>/../private-artifacts/shots the same way for the private tests.
"""
import json
import os
import re
import shutil
import subprocess
import sys

PRIVATE_TESTS = ("testProductionSignedIn", "testProductionGoogleSignIn")
NAMED = re.compile(r"^(test[A-Za-z0-9_]+)--(.+)\.(png|jpe?g|heic|txt)$")

artifacts = os.path.abspath(sys.argv[1])
private = os.path.join(os.path.dirname(artifacts), "private-artifacts")
attachments = os.path.join(artifacts, "attachments")
shots = os.path.join(artifacts, "shots")
private_shots = os.path.join(private, "shots")
for folder in (shots, private_shots):
    os.makedirs(folder, exist_ok=True)


def is_private_test(name):
    return any(name == test or name.startswith(test + "-") for test in PRIVATE_TESTS)


def mentions_private_test(line):
    return any(test + "-" in line or f'"{test}"' in line for test in PRIVATE_TESTS)


def downscale(src, dest):
    result = subprocess.run(
        ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "60", "-Z", "1400", src, "--out", dest],
        capture_output=True, text=True)
    if result.returncode != 0:
        print(f"sips failed for {src}: {result.stderr.strip()}")


# 1. Attachments: private ones leave the general artifact; screenshots are downscaled.
counts = {"public": 0, "private": 0}
if os.path.isdir(attachments):
    for name in sorted(os.listdir(attachments)):
        match = NAMED.match(name)
        if not match:
            continue
        test, moment, ext = match.groups()
        # Xcode adds "_<n>_<UUID>" to exported names; XCTest adds its own failure dumps.
        moment = re.sub(r"_\d+_[0-9A-Fa-f-]{36}$", "", moment)
        if moment.startswith("Debug-description"):
            continue
        src = os.path.join(attachments, name)
        secret = is_private_test(test)
        target = private_shots if secret else shots
        if ext == "txt":
            shutil.copyfile(src, os.path.join(target, f"{test}--{moment}.txt"))
        else:
            downscale(src, os.path.join(target, f"{test}--{moment}.jpg"))
        counts["private" if secret else "public"] += 1
    # The exported originals (UUID names) of private tests go too: find them through the manifest.
    manifest_path = os.path.join(attachments, "manifest.json")
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
        originals = os.path.join(private, "attachments")
        os.makedirs(originals, exist_ok=True)
        for test in manifest:
            test_name = test.get("testIdentifier", "").split("/")[-1].split("(")[0]
            if not is_private_test(test_name):
                continue
            for item in test.get("attachments", []):
                exported = os.path.join(attachments, item.get("exportedFileName", ""))
                if os.path.isfile(exported):
                    shutil.move(exported, os.path.join(originals, os.path.basename(exported)))
    for name in os.listdir(attachments):
        match = NAMED.match(name)
        if match and is_private_test(match.group(1)):
            os.makedirs(os.path.join(private, "attachments"), exist_ok=True)
            shutil.move(os.path.join(attachments, name), os.path.join(private, "attachments", name))


# 2. Line files: private lines move out.
def split_lines(name):
    path = os.path.join(artifacts, name)
    if not os.path.exists(path):
        return
    keep, move = [], []
    with open(path, errors="replace") as f:
        for line in f:
            (move if mentions_private_test(line) else keep).append(line)
    with open(path, "w") as f:
        f.writelines(keep)
    if move:
        with open(os.path.join(private, name), "w") as f:
            f.writelines(move)
    print(f"{name}: {len(keep)} lines kept, {len(move)} moved to the private artifact")


split_lines("diagnostics.jsonl")
split_lines("simulator-app.log")

# 3. Summary and diagnostics beside the screenshots.
for name in ("SUMMARY.md", "diagnostics.jsonl"):
    src = os.path.join(artifacts, name)
    if os.path.exists(src):
        shutil.copyfile(src, os.path.join(shots, name))
private_diag = os.path.join(private, "diagnostics.jsonl")
if os.path.exists(private_diag):
    shutil.copyfile(private_diag, os.path.join(private_shots, "diagnostics.jsonl"))

print(f"screenshots and texts: {counts['public']} public, {counts['private']} private")
