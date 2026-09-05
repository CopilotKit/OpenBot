#!/usr/bin/env bash
# Required inventory through the authoritative helper; Docker only inspects
# containers it names (plus the already-required supervised G0 computer).
set -euo pipefail
set +x
[[ "$#" -eq 2 && "$1" == --lock-held-fd && "$2" =~ ^[0-9]+$ ]] || exit 64
readonly lock_fd="$2"
readonly helper="${OPENBOT_COMPOSE_HELPER:-/usr/local/lib/netsfera/openbot-compose-v1.sh}"
readonly wait_seconds="${OPENBOT_HEALTH_TIMEOUT_SECONDS:-120}"
[[ "$wait_seconds" =~ ^[1-9][0-9]*$ && "$wait_seconds" -le 600 ]] || exit 64
readonly required_services=(openbot postgres bot-backend-ts supervisor)
"$helper" --lock-held-fd "$lock_fd" config --quiet || exit 65

inspect_running() {
  local service="$1" id="$2" state
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null)" || return 1
  [[ "$state" == 'running healthy' || "$state" == 'running none' ]] || return 1
  printf 'service=%s container=%s state=%s\n' "$service" "$id" "$state"
}

inventory() {
  local service ids id
  for service in "${required_services[@]}"; do
    ids="$("$helper" --lock-held-fd "$lock_fd" ps --all -q "$service")" || return 1
    # An unknown service makes ps fail; a missing container yields no ids.
    [[ -n "$ids" ]] || return 1
    for id in $ids; do inspect_running "$service" "$id" || return 1; done
  done
  inspect_running supervised-computer openbot-computer-general-assistant
}

deadline=$((SECONDS + wait_seconds))
while ! evidence="$(inventory)"; do
  if ((SECONDS >= deadline)); then
    printf 'required OpenBot inventory is missing, stopped or unhealthy after %ss\n' "$wait_seconds" >&2
    exit 65
  fi
  sleep 1
done
printf '%s\n' "$evidence"
