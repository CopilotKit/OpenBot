#!/usr/bin/env python3
"""Fails when a recording is too short to show anything.

Usage: check_video.py <video.mp4> <xcodebuild log> <minimum seconds>

The runner has no ffprobe: the length is the time between the test's video marks
(`video-mark start/end <epoch>` in the log), and the file must be more than 1 MB.
"""
import os
import re
import sys

video, log_path, minimum = sys.argv[1], sys.argv[2], float(sys.argv[3])
size = os.path.getsize(video) if os.path.exists(video) else 0
with open(log_path, errors="replace") as f:
    log = f.read()
starts = [float(x) for x in re.findall(r"video-mark start ([0-9.]+)", log)]
ends = [float(x) for x in re.findall(r"video-mark end ([0-9.]+)", log)]
length = (ends[-1] - starts[0]) if starts and ends else 0.0
print(f"{video}: {size} bytes, marked length {length:.1f} s (minimum {minimum:.0f} s)")
if size < 1_000_000 or length < minimum:
    print(f"::error::the recording {os.path.basename(video)} is too short or empty")
    sys.exit(1)
