#!/usr/bin/env bash
# An actual OpenBot restart through the same manifest-bound helper used by
# netsfera-openbot.service, with the inherited deployment lock held throughout.
set -euo pipefail
set +x
[[ "$#" -eq 5 && "$1" == --lock-held-fd && "$2" =~ ^[0-9]+$ ]] || exit 64
readonly lock_fd="$2" evidence="$3" approved_route="$4" expected_status="$5"
readonly source_directory="${OPENBOT_SOURCE_DIR:-/opt/openbot/source}"
readonly helper="${OPENBOT_COMPOSE_HELPER:-/usr/local/lib/netsfera/openbot-compose-v1.sh}"
[[ "$approved_route" == https://* || "$approved_route" == http://* ]] || exit 64
[[ "$expected_status" =~ ^[1-5][0-9]{2}$ ]] || exit 64
route_check() {
  local status
  status="$(curl --silent --show-error --max-time 30 --output /dev/null --write-out '%{http_code}' "$approved_route")" || return 65
  [[ "$status" == "$expected_status" ]] || { printf '%s\n' 'approved external route failed' >&2; return 65; }
  printf 'external_http_status=%s\n' "$status"
}
runtime_check() {
  "${source_directory}/deploy/netsfera/verify-openbot-runtime.sh" --lock-held-fd "$lock_fd"
  "${source_directory}/deploy/netsfera/verify-staged-g1.sh" --lock-held-fd "$lock_fd" post-apply "$evidence"
}
runtime_check
route_check
before="$("$helper" --lock-held-fd "$lock_fd" ps -q openbot)"
[[ "$before" =~ ^[a-f0-9]{64}$ ]] || exit 65
printf 'restart_before_container=%s\n' "$before"
before_started="$(docker inspect --format '{{.State.StartedAt}}' "$before")"
before_restarts="$(docker inspect --format '{{.RestartCount}}' "$before")"
[[ -n "$before_started" ]] || exit 65
[[ "$before_restarts" =~ ^[0-9]+$ ]] || exit 65
printf 'restart_before_started_at=%s\nrestart_before_count=%s\n' "$before_started" "$before_restarts"
"$helper" --lock-held-fd "$lock_fd" restart openbot
runtime_check
after="$("$helper" --lock-held-fd "$lock_fd" ps -q openbot)"
[[ "$after" =~ ^[a-f0-9]{64}$ ]] || exit 65
after_started="$(docker inspect --format '{{.State.StartedAt}}' "$after")"
after_restarts="$(docker inspect --format '{{.RestartCount}}' "$after")"
[[ "$after_restarts" =~ ^[0-9]+$ ]] || exit 65
if [[ "$after" == "$before" && "$after_restarts" -gt "$before_restarts" ]] || \
  [[ "$after" != "$before" && "$after_restarts" -ne 0 ]]; then
  printf '%s\n' 'OpenBot has new automatic restarts; persistence acceptance failed' >&2
  exit 65
fi
[[ -n "$after_started" && ( "$after" != "$before" || "$after_started" != "$before_started" ) ]] || {
  printf '%s\n' 'OpenBot did not restart; persistence acceptance failed' >&2
  exit 65
}
printf 'restart_after_container=%s\nrestart_after_started_at=%s\nrestart_after_count=%s\nrestart_observed=true\n' "$after" "$after_started" "$after_restarts"
route_check
