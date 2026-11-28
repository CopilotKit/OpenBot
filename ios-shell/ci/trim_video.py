#!/usr/bin/env python3
"""Trims a simulator recording to the part a test marked, and keeps it under ~40 MB.

Usage: trim_video.py <video.mp4> <xcodebuild log> <epoch when the recording started>

With ffmpeg it also writes <video>-600.mp4, a 600-px-wide H.264 copy for a phone.

The test prints `SHELL_NOTE <test>: video-mark start <epoch>` and `... video-mark end <epoch>`
(the simulator shares the Mac's clock). Uses ffmpeg when the runner has it, else ci/video_tool.swift
(AVFoundation), else leaves the file as it is.
"""
import os
import re
import shutil
import subprocess
import sys

video, log_path, started_text = sys.argv[1:4]
if not os.path.exists(video):
    sys.exit(f"no {video}")
started = float(started_text)
with open(log_path, errors="replace") as f:
    log = f.read()
starts = [float(x) for x in re.findall(r"video-mark start ([0-9.]+)", log)]
ends = [float(x) for x in re.findall(r"video-mark end ([0-9.]+)", log)]
begin = max(0.0, (starts[0] - started - 1.0)) if starts else 0.0
length = (ends[-1] - started + 1.5 - begin) if ends else None
print(f"trim: start at {begin:.1f} s, length {length if length is None else round(length, 1)} s")

tmp = video + ".trim.mp4"
small = video[:-4] + "-600.mp4"
tool = os.path.join(os.path.dirname(os.path.abspath(__file__)), "video_tool.swift")
ffmpeg = shutil.which("ffmpeg")


def run(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode == 0, (result.stderr or "").strip()[:300]


if ffmpeg:
    cut = [ffmpeg, "-loglevel", "error", "-y", "-ss", f"{begin:.2f}", "-i", video] + (["-t", f"{length:.2f}"] if length else []) \
        + ["-c:v", "libx264", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", tmp]
    shrink = [ffmpeg, "-loglevel", "error", "-y", "-i", tmp, "-vf", "scale=600:-2", "-c:v", "libx264", "-crf", "28",
              "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", small]
else:
    # Compiled once (about 10 s) and run twice, rather than interpreted twice.
    binary = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "video_tool")
    if not os.path.exists(binary):
        subprocess.run(["xcrun", "swiftc", "-O", tool, "-o", binary], check=False)
    runner = [binary] if os.path.exists(binary) else ["xcrun", "swift", tool]
    cut = runner + [video, tmp, f"{begin:.2f}", f"{length or 0:.2f}", "0"]
    shrink = runner + [tmp, small, "0", "0", "600"]
ok, error = run(cut)
if ok and os.path.exists(tmp) and os.path.getsize(tmp) > 10000:
    ok2, error2 = run(shrink)
    os.replace(tmp, video)
    print(f"cut with {'ffmpeg' if ffmpeg else 'AVFoundation'}: {os.path.getsize(video)} bytes")
    print(f"600-px copy: {os.path.getsize(small) if ok2 and os.path.exists(small) else 'failed ' + error2}")
else:
    print(f"could not cut ({error}); the raw recording stays")
    if os.path.exists(tmp):
        os.remove(tmp)
