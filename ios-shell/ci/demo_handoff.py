"""Print allowlisted milestones for local-fixture UI tests."""

import json
import sys
from datetime import datetime
from pathlib import Path


def report(path, tests):
    if not path.is_file():
        print("No mock diagnostics were recorded.")
        return
    starts = {}
    milestones = {
        "launch", "session-cookie", "handoff-config", "sheet", "enter", "enter-timeout",
        "handoff-session-confirmed", "signed-in-by-url", "load-failure-lock", "session-ended",
        "page-load-begin", "page-load-end",
    }
    for line in path.read_text().splitlines():
        row = json.loads(line)
        kind = row.get("kind")
        test = row.get("test")
        if test not in tests or kind not in milestones:
            continue
        stamp = datetime.fromisoformat(row["ts"].replace("Z", "+00:00"))
        start = starts.setdefault(test, stamp)
        detail = ""
        if kind == "sheet" and row.get("result") in {"cancelled", "error", "no-ticket", "ticket"}:
            detail = " " + row["result"]
        if kind == "session-cookie":
            detail = f" present={row.get('present') is True} timedOut={row.get('timedOut') is True}"
        print(f"{test} +{(stamp-start).total_seconds():.1f}s {kind}{detail}")


if __name__ == "__main__":
    tests = {"testDemoTour-tour"}
    if sys.argv[2:] == ["skeleton"]:
        tests = {f"testLoadingSkeleton-{phase}" for phase in ("sign-in", "light", "dark")}
    report(Path(sys.argv[1]), tests)
