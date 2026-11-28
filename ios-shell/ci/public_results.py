#!/usr/bin/env python3
"""Export test outcomes and screenshots from local-fixture suites for public CI."""

import json
from pathlib import Path
import re
import subprocess
import sys

STATUS = re.compile(r"^Test Case '-\[(?:\w+\.)?(\w+) (\w+)\]' (passed|failed|skipped) \(([\d.]+) seconds\)\.$")
FIXTURE_SUITES = {"ShellFlowUITests", "DemoTourUITests"}


def main(output, attachments, logs):
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    for log in logs:
        if log.is_file():
            for line in log.read_text(errors="replace").splitlines():
                if match := STATUS.fullmatch(line.strip()):
                    suite, test, result, seconds = match.groups()
                    rows.append(f"- {suite}.{test} — {result} ({seconds} s)")
    summary = "\n".join(rows) or "No completed test cases were recorded."
    (output / "SUMMARY.md").write_text(summary + "\n")
    print(summary)
    for manifest in attachments.glob("*/manifest.json"):
        for group in json.loads(manifest.read_text()):
            suite, _, method = group.get("testIdentifier", "").partition("/")
            if suite not in FIXTURE_SUITES or not re.fullmatch(r"test\w+\(\)", method):
                continue
            for item in group.get("attachments", []):
                filename = item.get("exportedFileName", "")
                if not re.fullmatch(r"[\w-]+\.png", filename):
                    continue
                image = manifest.parent / filename
                label = re.sub(r"[^\w.-]", "-", item.get("suggestedHumanReadableName", image.name))
                dest = output / f"{method[:-2]}--{label}.jpg"
                subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "60",
                                "-Z", "1400", str(image), "--out", str(dest)],
                               check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), [Path(path) for path in sys.argv[3:]])
