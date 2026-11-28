"""Print only the mock recording's native sign-in milestones after a failure."""

import json
import sys
from datetime import datetime
from pathlib import Path


def report(path):
    if not path.is_file():
        print("No mock diagnostics were recorded.")
        return
    start = None
    milestones = {
        "launch", "session-cookie", "handoff-config", "sheet", "enter", "enter-timeout",
        "handoff-session-confirmed", "signed-in-by-url", "load-failure-lock", "session-ended",
        "page-load-begin", "page-load-end",
    }
    for line in path.read_text().splitlines():
        row = json.loads(line)
        kind = row.get("kind")
        if row.get("test") != "testDemoTour-tour" or kind not in milestones:
            continue
        stamp = datetime.fromisoformat(row["ts"].replace("Z", "+00:00"))
        if start is None:
            start = stamp
        detail = ""
        if kind == "sheet" and row.get("result") in {"cancelled", "error", "no-ticket", "ticket"}:
            detail = " " + row["result"]
        print(f"+{(stamp-start).total_seconds():.1f}s {kind}{detail}")


if __name__ == "__main__":
    report(Path(sys.argv[1]))
