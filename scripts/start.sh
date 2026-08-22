#!/usr/bin/env bash
#
# Start the local OpenBot stack and verify each service answers as OpenBot.
# Safe to rerun: matching services are left running, and unrelated port holders are reported.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOGS="$ROOT/.logs"
mkdir -p "$LOGS"

if [ ! -f "$ROOT/.env" ]; then
  printf '\033[31m%s\033[0m\n' ".env is missing. Copy .env.example to .env and fill in the required settings."
  exit 1
fi

# The environment first, then .env, then the default. Compose and the API server both read .env, so a
# port or token configured there is what this script must use as well.
setting() {
  local name="$1" fallback="$2" value="${!1:-}"
  if [ -z "$value" ]; then
    value="$(grep -E "^$name=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  fi
  printf '%s' "${value:-$fallback}"
}

APP_PORT="$(setting APP_PORT 3010)"
SERVER_PORT="$(setting SERVER_PORT 3001)"
COMPUTER_PORT="$(setting COMPUTER_PORT 4100)"
BOT_PORT="$(setting BOT_PORT 4200)"
LANGGRAPH_PORT="$(setting LANGGRAPH_PORT 4201)"
SUPERVISOR_PORT="$(setting SUPERVISOR_PORT 4500)"
ONE_COMPUTER_EACH="${OPENBOT_ONE_COMPUTER_EACH:-true}"
export APP_PORT SERVER_PORT
SUPERVISOR_TOKEN="$(setting SUPERVISOR_TOKEN openbot-dev-supervisor-token)"
COMPUTER_TOKEN="$(setting COMPUTER_TOKEN openbot-dev-computer-token)"

# The secret the server sends to a managed Bot, generated and written back on first run.
#
# Not a fixed default like the two above. Those reach services bound to loopback; a Bot publishes a
# port, so a well-known token from a public repository would be no boundary at all. Generated once
# per machine and persisted, because the server and the Bot are separate processes that have to
# agree on it across restarts.
#
# Written into .env rather than exported for this run alone, so `docker compose up` by hand later
# sees the same value the script used.
# The laptop stack runs agent-langgraph on LANGGRAPH_PORT. The one-container image does not, so
# this default stays in the script rather than in .env: a `docker run --env-file .env` must not
# inherit a URL that points at a process the image does not contain.
MANAGED_AGENT_AG_UI_URL="$(setting MANAGED_AGENT_AG_UI_URL "http://localhost:${LANGGRAPH_PORT}/ag-ui")"
export MANAGED_AGENT_AG_UI_URL

MANAGED_AGENT_TOKEN="$(setting MANAGED_AGENT_TOKEN "")"
if [ -z "$MANAGED_AGENT_TOKEN" ]; then
  MANAGED_AGENT_TOKEN="$(openssl rand -base64 32)"
  if grep -qE '^MANAGED_AGENT_TOKEN=' "$ROOT/.env"; then
    # A present but empty line, which is what .env.example ships.
    tmp="$(mktemp)"
    grep -vE '^MANAGED_AGENT_TOKEN=' "$ROOT/.env" > "$tmp"
    printf 'MANAGED_AGENT_TOKEN=%s\n' "$MANAGED_AGENT_TOKEN" >> "$tmp"
    mv "$tmp" "$ROOT/.env"
  else
    printf '\nMANAGED_AGENT_TOKEN=%s\n' "$MANAGED_AGENT_TOKEN" >> "$ROOT/.env"
  fi
  printf '\033[2m%s\033[0m\n' "Generated MANAGED_AGENT_TOKEN and wrote it to .env."
fi
export MANAGED_AGENT_TOKEN

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
info()  { printf '\033[2m%s\033[0m\n' "$1"; }

holder() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fcn 2>/dev/null | awk '/^c/{c=substr($0,2)} /^n/{print c" ("substr($0,2)")"; exit}' || true
}

require_free_or_ours() {
  local port="$1" name="$2" who
  who="$(holder "$port")"
  [ -z "$who" ] && return 0
  if curl -fsS --max-time 3 "http://localhost:$port/health" >/dev/null 2>&1 \
     || curl -fsS --max-time 3 "http://localhost:$port/api/capabilities" >/dev/null 2>&1 \
     || curl -fsS --max-time 3 "http://localhost:$port/" >/dev/null 2>&1; then
    info "  $name: already up on $port ($who)"
    return 0
  fi
  red "  $name: port $port is held by something else: $who"
  red "  Re-run with ${name^^}_PORT=<free port>, or stop that process yourself."
  exit 1
}

wait_for() {
  local url="$1" name="$2" tries="${3:-40}"
  for _ in $(seq 1 "$tries"); do
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1 && { green "  $name ready"; return 0; }
    sleep 1
  done
  red "  $name never became ready at $url"
  red "  Log: $LOGS/${name}.log"
  exit 1
}

echo
echo "OpenBot"
echo "======="

info "1/4  Docker services"
SERVICES=(postgres)
if [ "$ONE_COMPUTER_EACH" = "true" ]; then
  SERVICES+=(supervisor)
fi
for svc_port in "agent-computer:$COMPUTER_PORT" "agent-bot:$BOT_PORT" "agent-langgraph:$LANGGRAPH_PORT"; do
  svc="${svc_port%%:*}"; port="${svc_port##*:}"
  if curl -fsS --max-time 3 "http://localhost:$port/health" >/dev/null 2>&1; then
    info "  $svc: already answering on $port"
  else
    SERVICES+=("$svc")
  fi
done

export SUPERVISOR_TOKEN COMPUTER_TOKEN
export COMPUTER_PORT BOT_PORT LANGGRAPH_PORT SUPERVISOR_PORT
docker compose up -d --build "${SERVICES[@]}" >/dev/null
if ! docker compose run --rm --build migrate >"$LOGS/migrate.log" 2>&1; then
  red "  Migrations did not apply. The database is not the schema this server expects."
  red "  Log: $LOGS/migrate.log"
  exit 1
fi
wait_for "http://localhost:$COMPUTER_PORT/health" "agent-computer"
wait_for "http://localhost:$BOT_PORT/health" "agent-bot"
wait_for "http://localhost:$LANGGRAPH_PORT/health" "agent-langgraph"

for table in agent_profiles agent_preferences; do
  if ! docker compose exec -T postgres \
       psql -U openbot -d openbot -tAc "select to_regclass('public.$table')" 2>/dev/null \
       | grep -q "^$table$"; then
    red "  $table is missing. Run: bun run --cwd server db:migrate"
    exit 1
  fi
done
green "  coworker tables migrated"

# Resolved at the top, where the default that .env deliberately does not carry is applied. Reading
# .env again here would have demanded the line be present in a file the comment above that default
# says must not contain it, which is how this came to refuse every fresh clone: `cp .env.example
# .env` leaves it commented out, so the grep matched nothing.
#
# It failed silently, too. Under `set -o pipefail` a grep that matches nothing fails its whole
# pipeline, and `set -e` then aborts the assignment before the check below could say why. The same
# grep survives inside `setting()` only because `local v="$(...)"` takes `local`'s own exit status
# and masks it. So: report what was resolved, and do not re-read the file.
green "  managed coworker endpoint: $MANAGED_AGENT_AG_UI_URL"

info "2/4  Server"
require_free_or_ours "$SERVER_PORT" server
if ! curl -fsS --max-time 3 "http://localhost:$SERVER_PORT/api/capabilities" >/dev/null 2>&1; then
  if [ "$ONE_COMPUTER_EACH" = "true" ]; then
    (cd server && PORT="$SERVER_PORT" \
      COMPUTER_SUPERVISOR_URL="http://localhost:$SUPERVISOR_PORT" \
      SUPERVISOR_TOKEN="$SUPERVISOR_TOKEN" \
      COMPUTER_TOKEN="$COMPUTER_TOKEN" \
      bun --env-file=../.env src/index.ts >"$LOGS/server.log" 2>&1 &)
  else
    (cd server && PORT="$SERVER_PORT" bun --env-file=../.env src/index.ts >"$LOGS/server.log" 2>&1 &)
  fi
fi
wait_for "http://localhost:$SERVER_PORT/api/capabilities" "server"

info "3/4  Runtime health"
INFO="$(curl -fsS --max-time 8 "http://localhost:$SERVER_PORT/api/copilotkit/info")"
python3 - "$INFO" <<'PY'
import json, sys
info = json.loads(sys.argv[1])
status, agents = info.get("licenseStatus"), list(info.get("agents", {}))
if status != "valid":
    print(f"\033[31m  licence is '{status}', not 'valid'.\033[0m")
    print("\033[31m  Run: npx copilotkit@latest login && npx copilotkit@latest license --write\033[0m")
    print("\033[31m  See README.md for Intelligence setup.\033[0m")
    raise SystemExit(1)
if not agents:
    print("\033[31m  No Bots registered.\033[0m")
    raise SystemExit(1)
print(f"\033[32m  licence valid · mode {info.get('mode')} · Bots: {', '.join(agents)}\033[0m")
PY

info "4/4  App"
require_free_or_ours "$APP_PORT" app
if ! curl -fsS --max-time 3 "http://localhost:$APP_PORT/" >/dev/null 2>&1; then
  (cd app && bun run dev --port "$APP_PORT" --strictPort >"$LOGS/app.log" 2>&1 &)
fi
wait_for "http://localhost:$APP_PORT/" "app"

cat <<EOF

$(green "Ready. http://localhost:$APP_PORT")

Next steps:

  - Direct Bot chat:       http://localhost:$APP_PORT/bot
  - Coworkers:             http://localhost:$APP_PORT/agents
  - Audit trail:           http://localhost:$APP_PORT/admin/audit
  - Boundaries/policy:     http://localhost:$APP_PORT/admin/boundaries
  - Setup docs:            README.md
  - Configuration docs:    docs/configuration.md

Try:

  1. Open /bot and ask: Open news.ycombinator.com and tell me the top story.
  2. Create a coworker in /agents and start a channel with it.
  3. Review browser/file actions in /admin/audit.
  4. Add a deny rule in /admin/boundaries, then retry the same action.

Logs: $LOGS
Stop Docker services: docker compose down
Stop host app/server: kill the processes using ports $APP_PORT and $SERVER_PORT
EOF
