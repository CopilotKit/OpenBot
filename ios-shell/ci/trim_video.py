#!/usr/bin/env python3
"""Trims a simulator recording to the part a test marked, and keeps it under ~40 MB.

Usage: trim_video.py <video.mp4> <xcodebuild log> <epoch when the recording started>

With ffmpeg it also writes <video>-600.mp4, a 600-px-wide H.264 copy for a phone.

The test prints `SHELL_NOTE <test>: video-mark start <epoch>` and `... video-mark end <epoch>`
(the simulator shares the Mac's clock). Uses ffmpeg when the runner has it, else avconvert, else
leaves the file as it is.
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
ffmpeg = shutil.which("ffmpeg")
if ffmpeg:
    cmd = [ffmpeg, "-loglevel", "error", "-y", "-ss", f"{begin:.2f}", "-i", video]
    if length:
        cmd += ["-t", f"{length:.2f}"]
    cmd += ["-vf", "scale=720:-2", "-c:v", "libx264", "-crf", "26", "-pix_fmt", "yuv420p", tmp]
else:
    cmd = ["avconvert", "--source", video, "--output", tmp, "--preset", "PresetHEVC1920x1080", "--replace",
           "--start", f"{begin:.2f}"]
    if length:
        cmd += ["--duration", f"{length:.2f}"]
result = subprocess.run(cmd, capture_output=True, text=True)
if result.returncode == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > 10000:
    os.replace(tmp, video)
    print(f"trimmed with {os.path.basename(cmd[0])}: {os.path.getsize(video)} bytes")
else:
    print(f"could not trim ({result.stderr.strip()[:300]}); the raw recording stays")
    if os.path.exists(tmp):
        os.remove(tmp)

if ffmpeg and os.path.exists(video):
    small = video[:-4] + "-600.mp4"
    result = subprocess.run([ffmpeg, "-loglevel", "error", "-y", "-i", video, "-vf", "scale=600:-2", "-c:v", "libx264",
                             "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", small],
                            capture_output=True, text=True)
    print(f"600-px copy: {os.path.getsize(small) if result.returncode == 0 else 'failed ' + result.stderr[:200]}")
