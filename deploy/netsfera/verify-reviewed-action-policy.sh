#!/bin/sh
# The database wins at boot. Read it through the locked authoritative helper;
# absence or identical policy semantics is required, never an automatic reset.
set -eu
set +x
test "$#" -eq 3 && test "$1" = --lock-held-fd || exit 64
case "$2" in '' | *[!0-9]*) exit 65 ;; esac
readonly lock_fd="$2" reviewed_policy="$3"
readonly compose_helper="${OPENBOT_COMPOSE_HELPER:-/usr/local/lib/netsfera/openbot-compose-v1.sh}"
test -f "$reviewed_policy" && test ! -L "$reviewed_policy" || exit 65
if ! stored_policy="$("$compose_helper" --lock-held-fd "$lock_fd" exec -T postgres \
  psql -X -v ON_ERROR_STOP=1 -U openbot -d openbot -At -c \
  "SELECT COALESCE((SELECT jsonb_build_object('mode', mode, 'deny', deny, 'allow', allow) FROM action_policy WHERE id = 'current'), 'null'::jsonb)")"; then
  printf '%s\n' 'stored action policy could not be read; stop for operator review' >&2
  exit 65
fi
# JSON key order and layout are irrelevant. Mode, CEL expressions and rule order
# remain exact: order also determines the first matching rule recorded in Audit.
if ! printf '%s\n' "$stored_policy" | jq -e -s --slurpfile reviewed "$reviewed_policy" '
  length == 1 and ($reviewed | length) == 1 and $reviewed[0].mode == "enforce"
  and (.[0] == null or .[0] == $reviewed[0])
' >/dev/null 2>&1; then
  printf '%s\n' 'stored action policy diverges from the reviewed policy or is invalid; explicit operator reconciliation required' >&2
  exit 65
fi
printf '%s\n' 'stored_action_policy=absent-or-reviewed-equivalent'
