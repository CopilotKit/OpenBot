#!/usr/bin/env python3
"""Prints "<udid>\t<name>\t<runtime>" for the iPhone simulator CI should use.

Takes the newest iOS runtime that the selected Xcode's simulator SDK can run, and in it the
newest numbered iPhone that is not a Plus or Pro Max model (a regular or Pro size phone).
"""
import json
import re
import subprocess
import sys


def version(text):
    return tuple(int(x) for x in re.findall(r"\d+", text)[:2])


sdk = subprocess.check_output(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"], text=True).strip()
sdk_version = version(sdk)
devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"], text=True))

candidates = []
for runtime, entries in devices["devices"].items():
    match = re.search(r"iOS-(\d+)-(\d+)", runtime)
    if not match:
        continue
    runtime_version = (int(match.group(1)), int(match.group(2)))
    if runtime_version > sdk_version:
        continue
    for device in entries:
        name = device["name"]
        if not name.startswith("iPhone"):
            continue
        number = re.search(r"iPhone (\d+)", name)
        regular = not any(word in name for word in ("Max", "Plus"))
        candidates.append((runtime_version, regular, int(number.group(1)) if number else 0,
                           "Pro" not in name, device["udid"], name, runtime))

if not candidates:
    sys.exit(f"no available iPhone simulator for SDK {sdk}")
best = max(candidates)
print(f"{best[4]}\t{best[5]}\t{best[6]}")
