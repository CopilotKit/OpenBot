#!/usr/bin/env bash
#
# Stop everything `scripts/start.sh` started, in the reverse order it started them.
# Safe to rerun: anything already stopped is reported and skipped.
#
# Three things run, and they are stopped in this order so nothing is left calling something that
# has gone: the app, then the API server, then Docker. The server is a Compose service, and it does
# the scheduled work itself. What an earlier start ran is stopped too: a server or a routine worker
# on the host, and the `worker` container from when that was a Compose service. The Bot computers
# come last because they are made by the supervisor rather than by compose, so
# `docker compose down` leaves them running and they are the heaviest thing here, one Chromium each.

# Before anything else, and before the `set` line below, which is itself bash-only: this file is
# bash, and being read by `sh` used to end it with exit 1 and no output at all. See that file.
. "$(dirname "$0")/require-bash.sh"
# `holder`, `port_pids`, `kill_pids`, `running` and `stop_matching`, which also work in Git Bash on
# Windows. See that file.
. "$(dirname "$0")/processes.sh"

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

Stops the app, the API server, the Docker services, and each Bot's computer.

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
    # `|| true`, for `start.sh`'s reason: a key with a default here is routinely absent from `.env`
    # — of the two this reads, `.env.example` lists `SERVER_PORT` and not `APP_PORT` — and `grep`
    # finding nothing is an exit status of 1 that `pipefail` makes the pipeline's. The fallback on
    # the next line is what the second argument promises, and it must not depend on whether the key
    # happened to be written down.
    value="$(grep -E "^$name=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true)"
  fi
  printf '%s' "${value:-$fallback}"
}

APP_PORT="$(setting APP_PORT 3010)"
SERVER_PORT="$(setting SERVER_PORT 3001)"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
info()  { printf '\033[2m%s\033[0m\n' "$1"; }

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

# Whether a port is held by the container engine's own port forwarder rather than by a process of
# ours: Docker Desktop, Docker's proxy, Podman's. Killing that would take the engine down with it, so
# a port a container publishes is left to Compose.
held_by_engine() {
  case "$1" in
    com.docke* | docker* | vpnkit* | gvproxy* | rootlessp* | slirp4net* | podman* | wslrelay*) return 0 ;;
  esac
  return 1
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
  if held_by_engine "$who"; then
    info "  $name: published by a container on $port, which Compose stops below"
    return 0
  fi
  if ! identifies_as_openbot "$port" "$name"; then
    red "  $name: port $port is held by something that is not OpenBot: $who"
    red "  Left it alone. Stop it yourself if it is in the way."
    return 0
  fi
  pids="$(port_pids "$port")"
  [ -z "$pids" ] && { info "  $name: not running on $port"; return 0; }
  # shellcheck disable=SC2086
  kill_pids $pids
  sleep 2
  pids="$(port_pids "$port")"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill_pids -9 $pids
  fi
  green "  $name: stopped ($who)"
}

echo
echo "OpenBot"
echo "======="

info "1/3  App"
stop_port "$APP_PORT" app

info "2/3  API server"
# A routine worker an earlier start ran. As a Compose service, which docker-compose.yml no longer
# defines, so `docker compose down` below would leave its container running.
for retired in $(remove_retired_services); do
  green "  $retired from an earlier start: removed"
done
# Or on the host, by the pattern it was started with. It has to stay that specific: a bare
# `bun src/index.ts` matches the computer and supervisor containers on a Linux host.
if running "bun worker/src/index.ts"; then
  stop_matching "bun worker/src/index.ts"
  green "  worker on the host: stopped"
fi
if [ -n "$(docker compose ps -q server 2>/dev/null)" ]; then
  docker compose stop server >/dev/null 2>&1
  green "  server: stopped"
fi
# One an earlier start ran on the host, still on the port.
stop_port "$SERVER_PORT" server
# The personal edition's own browser, which an earlier start ran on the host beside the server. Its
# browser is asked to close first: the computer closes it on SIGTERM.
if running "bun scripts/start-local-chrome-computer.ts"; then
  stop_matching "bun scripts/start-local-chrome-computer.ts"
  green "  your browser: stopped"
fi

info "3/3  Docker"
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
