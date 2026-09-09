#!/usr/bin/env bash
#
# Stop everything `scripts/start.sh` started, in the reverse order it started them.
# Safe to rerun: anything already stopped is reported and skipped.
#
# Four things run, and they are stopped in this order so nothing is left calling something that has
# gone: the app, then the routine worker, then the API server, then Docker. The Bot computers come
# last because they are made by the supervisor rather than by compose, so `docker compose down`
# leaves them running and they are the heaviest thing here, one Chromium each.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

KEEP_COMPUTERS=false
for arg in "$@"; do
  case "$arg" in
    --keep-computers) KEEP_COMPUTERS=true ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/stop.sh [--keep-computers]

Stops the app, the routine worker, the API server, the Docker services, and each Bot's computer.

  --keep-computers  Leave the Bot computers running, so their browsers stay signed in and warm.
                    Their files and browser profiles are Docker volumes and survive either way.
EOF
      exit 0
      ;;
    *)
      printf '\033[31m%s\033[0m\n' "Unknown argument: $arg. Try --help."
      exit 1
      ;;
  esac
done

# The environment first, then .env, then the default: the same resolution order start.sh uses, so a
# port configured there is the port stopped here. A missing .env is not an error for stopping —
# the defaults still find whatever a previous run left behind.
setting() {
  local name="$1" fallback="$2" value="${!1:-}"
  if [ -z "$value" ] && [ -f "$ROOT/.env" ]; then
    value="$(grep -E "^$name=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  fi
  printf '%s' "${value:-$fallback}"
}

APP_PORT="$(setting APP_PORT 3010)"
SERVER_PORT="$(setting SERVER_PORT 3001)"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
info()  { printf '\033[2m%s\033[0m\n' "$1"; }

holder() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fcn 2>/dev/null | awk '/^c/{c=substr($0,2)} /^n/{print c" ("substr($0,2)")"; exit}' || true
}

# Does whatever holds this port answer as OpenBot, rather than merely answer?
#
# The same question start.sh asks before starting, asked here for the opposite reason. Starting on
# an occupied port is a failed run; killing the occupant of a port is somebody else's editor server
# gone. So a port holder is only killed once it has identified itself, and is otherwise named and
# left alone.
identifies_as_openbot() {
  local port="$1" name="$2"
  case "$name" in
    server)
      curl -fsS --max-time 3 "http://localhost:$port/api/copilotkit/info" 2>/dev/null \
        | grep -q '"licenseStatus"'
      ;;
    app)
      curl -fsS --max-time 3 "http://localhost:$port/" 2>/dev/null \
        | grep -qi '<title>[^<]*OpenBot'
      ;;
  esac
}

# Stop the process listening on a port, once it has proved to be ours.
#
# SIGTERM first, then SIGKILL for anything still holding the port two seconds later: bun and vite
# both exit on the first signal, but a process wedged mid-request would otherwise keep the port and
# make the next start.sh refuse it.
stop_port() {
  local port="$1" name="$2" who pids
  who="$(holder "$port")"
  if [ -z "$who" ]; then
    info "  $name: not running on $port"
    return 0
  fi
  if ! identifies_as_openbot "$port" "$name"; then
    red "  $name: port $port is held by something that is not OpenBot: $who"
    red "  Left it alone. Stop it yourself if it is in the way."
    return 0
  fi
  pids="$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && { info "  $name: not running on $port"; return 0; }
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 2
  pids="$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
  green "  $name: stopped ($who)"
}

echo
echo "OpenBot"
echo "======="

info "1/4  App"
stop_port "$APP_PORT" app

info "2/4  Routine worker"
# The same pattern start.sh starts it with, and it has to stay that specific: a bare `bun
# src/index.ts` matches the server, computer and supervisor containers on a Linux host too.
if pgrep -f "bun worker/src/index.ts" >/dev/null 2>&1; then
  pkill -f "bun worker/src/index.ts" || true
  green "  worker: stopped"
else
  info "  worker: not running"
fi

info "3/4  API server"
stop_port "$SERVER_PORT" server

info "4/4  Docker"
if docker compose ps --quiet 2>/dev/null | grep -q .; then
  docker compose down >/dev/null 2>&1
  green "  compose services: stopped"
else
  info "  compose services: not running"
fi

COMPUTERS="$(docker ps -q --filter label=openbot.supervisor=true 2>/dev/null || true)"
if [ -z "$COMPUTERS" ]; then
  info "  Bot computers: none running"
elif [ "$KEEP_COMPUTERS" = "true" ]; then
  info "  Bot computers: left running ($(printf '%s\n' "$COMPUTERS" | wc -l | tr -d ' ')), as asked"
else
  # shellcheck disable=SC2086
  docker rm -f $COMPUTERS >/dev/null 2>&1 || true
  green "  Bot computers: removed ($(printf '%s\n' "$COMPUTERS" | wc -l | tr -d ' '))"
fi

cat <<EOF

$(green "Stopped.")

Nothing was deleted. PostgreSQL, each Bot's files and each Bot's browser profile are Docker
volumes, so channels, credentials and signed-in sessions are all still there next time.

Start again: bash scripts/start.sh
EOF
