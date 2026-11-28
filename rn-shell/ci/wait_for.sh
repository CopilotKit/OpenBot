#!/usr/bin/env bash
# wait_for.sh <ready file> <failed file|-> <seconds> <log to show on failure>
# Waits for a background step's marker file; fails at once if it failed, or at the deadline.
set -u
ready="$1"; failed="$2"; seconds="$3"; log="${4:-}"
deadline=$((SECONDS + seconds))
while [ ! -f "$ready" ]; do
  if [ "$failed" != "-" ] && [ -f "$failed" ]; then
    echo "failed: $failed"; [ -n "$log" ] && tail -n 60 "$log"; exit 1
  fi
  if [ $SECONDS -gt $deadline ]; then
    echo "not ready after $seconds s: $ready"; [ -n "$log" ] && tail -n 60 "$log"; exit 1
  fi
  sleep 2
done
[ -n "$log" ] && tail -n 5 "$log"
exit 0
