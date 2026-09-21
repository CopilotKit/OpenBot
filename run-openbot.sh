#!/usr/bin/env bash
# Start OpenBot so it SURVIVES closing the terminal.
#
#   ./run-openbot.sh          start everything
#   ./run-openbot.sh status   see what is running
#   ./run-openbot.sh stop     stop everything
#
# Why this exists rather than just `bash scripts/start.sh`:
#   1. start.sh must be piped (| cat) or Docker Compose fails with
#      "failed to get console: provided file is not a console".
#   2. start.sh exits 1 at "3/4 Runtime health" because managed Intelligence
#      reports licence 'unknown'. That is cosmetic -- the deployment works --
#      but it means start.sh never reaches 4/4 and never starts the app.
#   3. start.sh launches the server and worker attached to your terminal, so
#      they die when you close the tab. The routines worker dying is the one
#      that matters: no worker, no scheduled dispute checks, and it fails
#      SILENTLY -- the Routines page still shows a healthy next-run time.
#
# Tokens below are the dev defaults from scripts/start.sh (lines 36, 37, 46).
# They are empty in .env, so the script falls back to these. Loopback only.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
mkdir -p .logs

WORKER_PAT="bun worker/src/index.ts"
SERVER_PAT="src/production-entry.ts"
APP_PAT="vite.js --port"

case "${1:-start}" in
  status)
    echo "== Docker =="
    docker compose ps --format '{{.Service}}\t{{.Status}}' 2>/dev/null || echo "  (docker not running)"
    echo "== Host processes =="
    for p in "$WORKER_PAT:worker" "$SERVER_PAT:server" "$APP_PAT:app"; do
      pat="${p%:*}"; name="${p##*:}"
      pid="$(pgrep -f "$pat" | head -1)"
      if [ -n "$pid" ]; then
        tty="$(ps -o tty= -p "$pid" | tr -d ' ')"
        [ "$tty" = "??" ] && echo "  $name: running (pid $pid, detached)" \
                          || echo "  $name: running (pid $pid, ATTACHED to $tty - dies with terminal)"
      else
        echo "  $name: NOT running"
      fi
    done
    echo "== Endpoints =="
    curl -fsS --max-time 3 http://localhost:3001/health >/dev/null 2>&1 && echo "  api  3001 ok" || echo "  api  3001 DOWN"
    curl -fsS --max-time 3 http://localhost:3010/ >/dev/null 2>&1 && echo "  app  3010 ok" || echo "  app  3010 DOWN"
    exit 0
    ;;
  stop)
    pkill -f "$APP_PAT" 2>/dev/null
    pkill -f "$SERVER_PAT" 2>/dev/null
    pkill -f "$WORKER_PAT" 2>/dev/null
    bash scripts/stop.sh 2>&1 | cat
    echo "stopped."
    exit 0
    ;;
esac

echo "1) Docker services, migrations, (transient) server + worker"
# Piped through cat on purpose: see note 1 above. Exit 1 at 3/4 is expected.
bash scripts/start.sh 2>&1 | cat || true

echo
echo "2) Relaunching server + worker detached from this terminal"
pkill -f "$SERVER_PAT" 2>/dev/null
pkill -f "$WORKER_PAT" 2>/dev/null
sleep 2

DB_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"

nohup env \
  DATABASE_URL="$DB_URL" \
  SERVER_INTERNAL_URL="http://localhost:3001" \
  WORKER_SHARED_SECRET="openbot-dev-worker-secret" \
  bun worker/src/index.ts > .logs/worker.log 2>&1 &
disown

# COMPUTER_SUPERVISOR_URL is deliberately NOT set below.
#
# Set, the supervisor gives every Bot its own sealed container: its own /workspace
# volume, no host bind mounts and none of this deployment's secrets (see
# supervisor/src/environment.ts and supervisor/src/docker.ts, which say so outright).
# That is the right posture, but it also means the Dev Agent's computer has no
# ~/Documents and no AI_GATEWAY_API_KEY, so opencode there has nothing to read and
# no model to read it with.
#
# Unset, every Bot shares the compose-managed computer on AGENT_COMPUTER_URL
# (:4100), which compose.override.yml has already given the projects mount, the
# gateway key and opencode's config.
#
# THE TRADE: one workspace, one browser profile and one key for ALL Bots. Any Bot
# with a shell can read every .env under ~/Documents. Acceptable on a single-user
# laptop; restore the line once the supervisor can pass mounts and an env allowlist.
( cd server && nohup env \
    PORT=3001 \
    SUPERVISOR_TOKEN="openbot-dev-supervisor-token" \
    COMPUTER_TOKEN="openbot-dev-computer-token" \
    WORKER_SHARED_SECRET="openbot-dev-worker-secret" \
    bun --env-file=../.env src/production-entry.ts > ../.logs/server.log 2>&1 & disown )

for i in $(seq 1 40); do
  curl -fsS --max-time 2 http://localhost:3001/health >/dev/null 2>&1 && break
  sleep 1
done

echo "3) App (UI) detached"
( cd app && nohup bun run dev --port 3010 --strictPort > ../.logs/app.log 2>&1 & disown )
for i in $(seq 1 40); do
  curl -fsS --max-time 2 http://localhost:3010/ >/dev/null 2>&1 && break
  sleep 1
done

echo
"$ROOT/run-openbot.sh" status
echo
echo "Open http://localhost:3010   -- safe to close this terminal."
