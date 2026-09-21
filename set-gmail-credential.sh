#!/usr/bin/env bash
# Point the Gmail connector at your mailbox.
#
#   ./set-gmail-credential.sh
#
# Prompts for the app password WITHOUT echoing it, and never writes it to disk or to a shell history
# file. It goes straight to the API, which encrypts it in the deployment's vault; nothing reads it
# back afterwards, including this script.
#
# The connector is handed ONE string, so the address and the password travel together as
# `you@gmail.com:apppassword` and gmail-imap.ts splits them on the last colon.

set -euo pipefail
API="http://localhost:3001"

printf 'Gmail address (the mailbox holding the dispute thread): '
read -r ADDRESS
printf 'App password (16 chars, spaces ignored, not echoed): '
read -rs APPPW
printf '\n'

# Google shows the password in four groups of four; the spaces are display only.
APPPW="${APPPW// /}"

if [ -z "$ADDRESS" ] || [ -z "$APPPW" ]; then echo "Both are required." >&2; exit 1; fi
case "$ADDRESS" in *@*) ;; *) echo "That does not look like an email address." >&2; exit 1;; esac
if [ "${#APPPW}" -ne 16 ]; then
  echo "Warning: app passwords are normally 16 characters; got ${#APPPW}. Continuing anyway." >&2
fi

CRED_ID="$(
  curl -fsS --max-time 10 -X POST "$API/api/admin/credentials" \
    -H 'content-type: application/json' \
    --data-binary @- <<JSON | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'
{"kind":"mcp","provider":"gmail","keyId":"mcp-gmail",
 "plaintext":"${ADDRESS}:${APPPW}","metadata":{"server":"gmail"}}
JSON
)"

unset APPPW

if [ -z "$CRED_ID" ]; then echo "The credential was not stored." >&2; exit 1; fi

curl -fsS --max-time 10 -X POST "$API/api/plugins/servers" \
  -H 'content-type: application/json' \
  -d "{\"key\":\"gmail\",\"credentialId\":\"$CRED_ID\"}" > /dev/null

echo "Stored and attached. Reload /admin/plugins -- Access token should now read 'Set'."
