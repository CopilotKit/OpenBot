#!/usr/bin/env bash
# Staple a notarization ticket to a file, or validate the one stapled to it, trying again only when
# the connection to Apple drops.
#
# Both ask Apple's CloudKit for the ticket Apple has already issued, a lookup that is safe to repeat.
# That connection drops: the first real signing run had Apple accept the Intel disk image and then
# lost it while stapling, and v0.3.3 lost it while validating, three times, each after Gatekeeper had
# accepted the app as notarized. Each time stapler printed NSURLErrorDomain -1005 ("The network
# connection was lost") and exited 68, its code for not reaching CloudKit. So 68 is tried again
# after a pause that doubles, as Apple's QA1941 says a dropped idempotent request can be, and as
# Chromium's notarize.py does for stapler.
#
# Any other failure is Apple's answer and fails at once with stapler's own code: 65 for a file with
# no ticket (an ad-hoc build, an image never notarized), 66 for a file that is not there.
#
# Usage: staple-with-retry.sh <file> [attempts]
# STAPLER_ACTION is `staple` (the default) or `validate`. XCRUN and STAPLE_RETRY_DELAY exist so the
# regression test (staple-with-retry.test.ts) can stand in for xcrun and not wait.
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

# What stapler exits with when it could not reach CloudKit (sysexits' EX_NOHOST).
connection_lost=68

for attempt in $(seq 1 "$attempts"); do
  status=0
  "$xcrun_bin" stapler "$action" "$file" || status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$status" -ne "$connection_lost" ]; then
    echo "$doing $file failed with stapler's error $status, which is Apple's answer rather than a lost connection, so it is not tried again." >&2
    exit "$status"
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    echo "$doing lost the connection to Apple (attempt $attempt of $attempts); trying again in ${delay}s." >&2
    sleep "$delay"
    delay=$((delay * 2))
  fi
done
echo "$doing $file failed after $attempts attempts: the connection to Apple kept dropping." >&2
exit "$connection_lost"
