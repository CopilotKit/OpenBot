#!/usr/bin/env python3
"""Check the video track duration, including footage from an interrupted tour."""

import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

video, log_path, minimum_text = sys.argv[1:]
minimum = float(minimum_text)
log = Path(log_path).read_text(errors="replace")
starts = re.findall(r"video-mark start ([0-9.]+)", log)
ends = re.findall(r"video-mark end ([0-9.]+)", log)
if not starts:
    sys.exit("::error::the tour never recorded its start")

probe = shutil.which("ffprobe")
if probe:
    command = [probe, "-v", "error", "-select_streams", "v:0", "-show_entries",
               "stream=duration", "-of", "csv=p=0", video]
else:
    # The trim step builds this AVFoundation helper on runners without ffmpeg.
    tool = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "video_tool"
    command = [str(tool)] if tool.is_file() else ["xcrun", "swift", str(Path(__file__).with_name("video_tool.swift"))]
    command.extend(["--duration", video])
result = subprocess.run(command, capture_output=True, text=True)
try:
    duration = float(result.stdout.strip())
except ValueError:
    duration = 0
if result.returncode or not math.isfinite(duration) or duration < minimum:
    sys.exit(f"::error::{Path(video).name} has no video track of at least {minimum:g} seconds")
print(f"{Path(video).name} contains {duration:.1f} seconds of video.")
if ends:
    if float(ends[-1]) - float(starts[0]) < minimum:
        sys.exit(f"::error::the marked tour lasted less than {minimum:g} seconds")
else:
    print("The tour ended before its end marker. The recording contains the partial journey.")
