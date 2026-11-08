#!/usr/bin/env bash
# Staple a notarization ticket to a file, or validate the one stapled to it, retrying when the
# connection to Apple drops.
#
# Stapling fetches the ticket Apple has already issued from Apple's CloudKit. The first real signing
# run had Apple accept the Intel disk image and then lost the stapler's connection ("The network
# connection was lost", NSURLErrorDomain -1005), which failed the job with a good, notarized build in
# hand. Validating asks CloudKit too, and lost its connection the same way in a dry run, after
# Gatekeeper had accepted the app as notarized. Both are idempotent, so each is tried again after a
# pause; a ticket that truly does not exist still fails, after the last attempt, with the stapler's
# own error.
#
# Usage: staple-with-retry.sh <file> [attempts]
# STAPLER_ACTION is `staple` (the default) or `validate`. XCRUN and STAPLE_RETRY_DELAY exist so the
# regression check can stand in for xcrun and not wait.
set -euo pipefail

file="${1:?usage: staple-with-retry.sh <file> [attempts]}"
attempts="${2:-5}"
action="${STAPLER_ACTION:-staple}"
xcrun_bin="${XCRUN:-xcrun}"
delay="${STAPLE_RETRY_DELAY:-15}"
case "$action" in
  staple) doing=Stapling ;;
  validate) doing=Validating ;;
  *)
    echo "STAPLER_ACTION must be staple or validate, got '$action'." >&2
    exit 1
    ;;
esac

for attempt in $(seq 1 "$attempts"); do
  if "$xcrun_bin" stapler "$action" "$file"; then
    exit 0
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    echo "$doing failed (attempt $attempt of $attempts); trying again in ${delay}s." >&2
    sleep "$delay"
    delay=$((delay * 2))
  fi
done
echo "$doing $file failed after $attempts attempts." >&2
exit 1
