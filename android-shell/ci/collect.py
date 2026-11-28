#!/usr/bin/env python3
"""Builds the downscaled screenshot sets: <dir>/raw-shots/*.png -> <dir>/shots/*.jpg (max 1000 px).

Usage: collect.py <artifacts dir> [<private artifacts dir>]
run_tests.py already put the real-account tests' screenshots in the private directory.
"""
import os
import shutil
import subprocess
import sys

for folder in sys.argv[1:]:
    raw = os.path.join(folder, "raw-shots")
    shots = os.path.join(folder, "shots")
    os.makedirs(shots, exist_ok=True)
    if not os.path.isdir(raw):
        continue
    convert = shutil.which("magick") or shutil.which("convert")
    count = 0
    for name in sorted(os.listdir(raw)):
        if not name.endswith(".png"):
            continue
        src = os.path.join(raw, name)
        dest = os.path.join(shots, name[:-4] + ".jpg")
        if convert:
            result = subprocess.run([convert, src, "-resize", "1000x1000>", "-quality", "70", dest], capture_output=True, text=True)
            if result.returncode != 0:
                shutil.copyfile(src, os.path.join(shots, name))
        else:
            shutil.copyfile(src, os.path.join(shots, name))
        count += 1
    shutil.rmtree(raw)
    for extra in ("SUMMARY.md",):
        if os.path.exists(os.path.join(folder, extra)):
            shutil.copyfile(os.path.join(folder, extra), os.path.join(shots, extra))
    print(f"{folder}: {count} screenshots")
