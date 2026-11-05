#!/usr/bin/env bash
# Staple a notarization ticket to a file, retrying when the connection to Apple drops.
#
# Stapling fetches the ticket Apple has already issued from Apple's CloudKit. The first real signing
# run had Apple accept the Intel disk image and then lost the stapler's connection ("The network
# connection was lost", NSURLErrorDomain -1005), which failed the job with a good, notarized build in
# hand. Stapling is idempotent, so it is tried again after a pause; a ticket that truly does not
# exist still fails, after the last attempt, with the stapler's own error.
#
# Usage: staple-with-retry.sh <file> [attempts]
# XCRUN and STAPLE_RETRY_DELAY exist so the regression check can stand in for xcrun and not wait.
set -euo pipefail

file="${1:?usage: staple-with-retry.sh <file> [attempts]}"
attempts="${2:-5}"
xcrun_bin="${XCRUN:-xcrun}"
delay="${STAPLE_RETRY_DELAY:-15}"

for attempt in $(seq 1 "$attempts"); do
  if "$xcrun_bin" stapler staple "$file"; then
    exit 0
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    echo "Stapling failed (attempt $attempt of $attempts); trying again in ${delay}s." >&2
    sleep "$delay"
    delay=$((delay * 2))
  fi
done
echo "Stapling $file failed after $attempts attempts." >&2
exit 1
