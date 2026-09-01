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
CODEX_AGENT_PORT="$(setting CODEX_AGENT_PORT 4202)"
SUPERVISOR_PORT="$(setting SUPERVISOR_PORT 4500)"
ONE_COMPUTER_EACH="${OPENBOT_ONE_COMPUTER_EACH:-true}"
CODEX_AGENT_ENABLED="$(setting CODEX_AGENT_ENABLED false)"
case "$CODEX_AGENT_ENABLED" in
  true|false) ;;
  *)
    printf '\033[31m%s\033[0m\n' "CODEX_AGENT_ENABLED must be true or false."
    exit 1
    ;;
esac
export APP_PORT SERVER_PORT
SUPERVISOR_TOKEN="$(setting SUPERVISOR_TOKEN openbot-dev-supervisor-token)"
COMPUTER_TOKEN="$(setting COMPUTER_TOKEN openbot-dev-computer-token)"
# A fixed default is fine here, unlike `AGENT_TOOL_TOKEN` below, but not because of where the server
# listens — it binds no hostname, so this port is reachable from the network like any other. It is
# fine because this is a dev-only default on a machine's own dev stack, and the endpoint it guards
# accepts nothing but an unguessable `routine_run_<uuid>` id: the server re-reads the routine, the
# owner and the channel from its own tables rather than trusting anything else the caller says, so
# the fixed default gates nothing sensitive here. That is also why it is generated fresh and
# persisted for AGENT_TOOL_TOKEN (see the SECRETS_ROTATED block) but not for this one — production
# must set a real WORKER_SHARED_SECRET.
WORKER_SHARED_SECRET="$(setting WORKER_SHARED_SECRET openbot-dev-worker-secret)"

# The secret the server sends to a managed Bot, generated and written back on first run.
#
# Not a fixed default like the two above. Those reach services bound to loopback; a Bot publishes a
# port, so a well-known token from a public repository would be no boundary at all. Generated once
# per machine and persisted, because the server and the Bot are separate processes that have to
# agree on it across restarts.
#
# Written into .env rather than exported for this run alone, so `docker compose up` by hand later
# sees the same value the script used.
# The laptop stack normally runs agent-langgraph on LANGGRAPH_PORT. The local Codex compatibility
# mode instead runs a host process so it can reuse the person's existing `codex login` session
# without copying ChatGPT credentials into Docker.
if [ "$CODEX_AGENT_ENABLED" = "true" ]; then
  DEFAULT_MANAGED_AGENT_URL="http://localhost:${CODEX_AGENT_PORT}/ag-ui"
else
  DEFAULT_MANAGED_AGENT_URL="http://localhost:${LANGGRAPH_PORT}/ag-ui"
fi
MANAGED_AGENT_AG_UI_URL="$(setting MANAGED_AGENT_AG_UI_URL "$DEFAULT_MANAGED_AGENT_URL")"
export MANAGED_AGENT_AG_UI_URL

# Whether this run minted a secret that something already running may not have.
#
# A process that is answering is not necessarily a process holding the current configuration, and
# the two are easy to confuse because one is observable and the other is not. Everything below that
# skips work because a service "is already up" has to consult this first.
SECRETS_ROTATED=false

MANAGED_AGENT_TOKEN="$(setting MANAGED_AGENT_TOKEN "")"
if [ -z "$MANAGED_AGENT_TOKEN" ]; then
  SECRETS_ROTATED=true
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

# The secret a framework Bot presents when it calls a tool back through this server. The other
# direction of the pair above: that one is the server proving itself to the Bot, this one is the Bot
# proving itself to the server, and they are deliberately two different secrets.
#
# Generated here for the same reason, and it has to be. `.env.example` ships it empty, which is the
# right default for a deployment: absent, no Bot may call tools back and it is told so rather than
# quietly allowed. On a laptop that default meant every MCP tool was dead on arrival. An
# administrator could enable Google Drive, grant `search_files` to a Bot, read "May call this tool"
# on the grant screen, and get "This Bot has no credential for calling tools back through its
# deployment" on every single call, with no audit row, because the call never reached the server to
# be recorded.
AGENT_TOOL_TOKEN="$(setting AGENT_TOOL_TOKEN "")"
if [ -z "$AGENT_TOOL_TOKEN" ]; then
  SECRETS_ROTATED=true
  AGENT_TOOL_TOKEN="$(openssl rand -base64 32)"
  if grep -qE '^AGENT_TOOL_TOKEN=' "$ROOT/.env"; then
    # A present but empty line, which is what .env.example ships.
    tmp="$(mktemp)"
    grep -vE '^AGENT_TOOL_TOKEN=' "$ROOT/.env" > "$tmp"
    printf 'AGENT_TOOL_TOKEN=%s\n' "$AGENT_TOOL_TOKEN" >> "$tmp"
    mv "$tmp" "$ROOT/.env"
  else
    printf '\nAGENT_TOOL_TOKEN=%s\n' "$AGENT_TOOL_TOKEN" >> "$ROOT/.env"
  fi
  printf '\033[2m%s\033[0m\n' "Generated AGENT_TOOL_TOKEN and wrote it to .env."
fi
export AGENT_TOOL_TOKEN

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
info()  { printf '\033[2m%s\033[0m\n' "$1"; }

holder() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fcn 2>/dev/null | awk '/^c/{c=substr($0,2)} /^n/{print c" ("substr($0,2)")"; exit}' || true
}

# Does whatever holds this port answer as OpenBot, rather than merely answer?
#
# `curl -f` proves something is listening and returned 2xx. That is not the same claim, and the gap
# between them is not academic: any single-page app serves its own index.html for every path it does
# not recognise, so an unrelated dashboard sitting on a default port answers 200 to
# `/api/capabilities` as readily as this server does.
#
# When that happened here the cost was not a wrong answer, it was a wrong answer three stages later.
# `require_free_or_ours` reported "already up", the server was therefore never started, `wait_for`
# printed a green "server ready", and the run died at stage 3 in `json.loads` on a mouthful of HTML —
# a JSON parse error standing in for "that port belongs to something else".
#
# So each surface is asked for something only it can produce.
identifies_as_openbot() {
  local port="$1" name="$2"
  case "$name" in
    # A field of this server's own payload. A stray 200 does not carry it.
    server)
      curl -fsS --max-time 3 "http://localhost:$port/api/copilotkit/info" 2>/dev/null \
        | grep -q '"licenseStatus"'
      ;;
    # The app is static HTML with nothing to interrogate, so its title is the identity available.
    app)
      curl -fsS --max-time 3 "http://localhost:$port/" 2>/dev/null \
        | grep -qi '<title>[^<]*OpenBot'
      ;;
    agent-codex)
      curl -fsS --max-time 3 "http://localhost:$port/health" 2>/dev/null \
        | grep -q '"safety":"openbot-governed-tools"'
      ;;
    # Compose services on dedicated loopback ports, answering a route named for this stack.
    *)
      curl -fsS --max-time 3 "http://localhost:$port/health" >/dev/null 2>&1
      ;;
  esac
}

require_free_or_ours() {
  local port="$1" name="$2" who
  who="$(holder "$port")"
  [ -z "$who" ] && return 0
  if identifies_as_openbot "$port" "$name"; then
    info "  $name: already up on $port ($who)"
    return 0
  fi
  red "  $name: port $port is held by something that is not OpenBot: $who"
  red "  Re-run with ${name^^}_PORT=<free port>, or stop that process yourself."
  exit 1
}

# As wait_for, but satisfied only by OpenBot answering, not by anything answering.
wait_for_openbot() {
  local port="$1" name="$2" tries="${3:-40}"
  for _ in $(seq 1 "$tries"); do
    identifies_as_openbot "$port" "$name" && { green "  $name ready"; return 0; }
    sleep 1
  done
  red "  $name never answered as OpenBot on port $port"
  red "  Either it failed to start, or that port belongs to another process."
  red "  Log: $LOGS/${name}.log"
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
#
# Every Bot service, every run, whether or not it is already answering.
#
# This used to skip one that answered its health route, which sounds like an optimisation and is
# actually a correctness bug: answering says the process is alive, not that its environment still
# matches the deployment's. A skipped service is never handed to `docker compose up`, so compose
# never compares its configuration and never recreates it.
#
# Which is how a Bot ends up holding a secret this deployment no longer accepts. `AGENT_TOOL_TOKEN`
# is generated above and written to .env; if the container was answering, it kept the previous one,
# and every tool call it made was refused at the door. It returns nothing to its own model, and the
# model tells the person there were no results — a false negative delivered as an answer.
#
# `docker compose up -d` is declarative and does nothing for a service whose configuration has not
# changed, so naming them all costs a comparison and buys the guarantee that what is running is what
# this run configured.
SERVICES+=(agent-computer)
if [ "$CODEX_AGENT_ENABLED" != "true" ]; then
  SERVICES+=(agent-bot agent-langgraph)
fi

export SUPERVISOR_TOKEN COMPUTER_TOKEN WORKER_SHARED_SECRET
export COMPUTER_PORT BOT_PORT LANGGRAPH_PORT CODEX_AGENT_PORT SUPERVISOR_PORT
docker compose up -d --build "${SERVICES[@]}" >/dev/null
if ! docker compose run --rm --build migrate >"$LOGS/migrate.log" 2>&1; then
  red "  Migrations did not apply. The database is not the schema this server expects."
  red "  Log: $LOGS/migrate.log"
  exit 1
fi
wait_for "http://localhost:$COMPUTER_PORT/health" "agent-computer"
if [ "$CODEX_AGENT_ENABLED" = "true" ]; then
  CODEX_AGENT_WORKSPACE="$(setting CODEX_AGENT_WORKSPACE "$ROOT/.openbot-codex/workspace")"
  CODEX_AGENT_STATE="$(setting CODEX_AGENT_STATE "$ROOT/.openbot-codex/threads.json")"
  OPENBOT_TOOL_URL="$(setting OPENBOT_TOOL_URL "http://localhost:${SERVER_PORT}/api/agent-tools/call")"
  mkdir -p "$CODEX_AGENT_WORKSPACE"
  require_free_or_ours "$CODEX_AGENT_PORT" "agent-codex"
  if identifies_as_openbot "$CODEX_AGENT_PORT" "agent-codex"; then
    pkill -f "bun agent-codex/src/index.ts" >/dev/null 2>&1 || true
    sleep 1
  fi
  (cd "$ROOT" && \
    nohup env \
      PORT="$CODEX_AGENT_PORT" \
      MANAGED_AGENT_TOKEN="$MANAGED_AGENT_TOKEN" \
      AGENT_TOOL_TOKEN="$AGENT_TOOL_TOKEN" \
      OPENBOT_TOOL_URL="$OPENBOT_TOOL_URL" \
      CODEX_AGENT_WORKSPACE="$CODEX_AGENT_WORKSPACE" \
      CODEX_AGENT_STATE="$CODEX_AGENT_STATE" \
      bun agent-codex/src/index.ts >"$LOGS/agent-codex.log" 2>&1 </dev/null &)
  wait_for "http://localhost:$CODEX_AGENT_PORT/health" "agent-codex" 60
else
  wait_for "http://localhost:$BOT_PORT/health" "agent-bot"
  wait_for "http://localhost:$LANGGRAPH_PORT/health" "agent-langgraph"
fi

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
if [ "$CODEX_AGENT_ENABLED" = "true" ]; then
  green "  Codex coworker: ChatGPT login · persistent threads · OpenBot-governed tools"
fi

info "2/4  Server"
require_free_or_ours "$SERVER_PORT" server
#
# A running server is left alone UNLESS this run minted a secret, because it read its environment
# once at startup and has no way to notice the file changed underneath it.
#
# Skipping it on "already answering" is the same mistake the Bot containers had: answering proves the
# process is alive, not that it agrees with the deployment. A server holding the previous
# `AGENT_TOOL_TOKEN` refuses every callback its own Bots make, which reaches a person as "no results"
# rather than as an error.
if [ "$SECRETS_ROTATED" = "true" ]; then
  info "  a secret was generated this run, so the server is restarted to pick it up"
  pkill -f "bun --env-file=../.env src/index.ts" >/dev/null 2>&1 || true
  sleep 1
fi
#
# A server that answers as OpenBot can still be one no worker can hand a routine to. The worker
# below is started unconditionally with this run's WORKER_SHARED_SECRET, and every dispatch it makes
# is one POST to this server's /internal/routines/run — a door that a server started from an older
# checkout does not have (404), and that a server started before this secret existed in its
# environment holds shut (401, `workerSharedSecret` undefined or different). Either way routines
# never fire, and nothing at start time says why.
#
# So before keeping a running server, ask it the one thing only a compatible one answers well: POST
# the handoff route with this run's secret and a deliberately empty body. In server/src/app.ts the
# secret is checked before the body is parsed, so a server holding this same secret rejects the
# empty body with 400 — the healthy answer. 401 means it does not hold this secret; 404 means it
# predates the route. Both are cured by a restart into this run's environment, so fall through to
# the launch below. Anything else — including a probe that could not connect at all — keeps the
# philosophy of leaving an answering server alone.
if identifies_as_openbot "$SERVER_PORT" server; then
  HANDOFF_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
    -X POST "http://localhost:$SERVER_PORT/internal/routines/run" \
    -H "Authorization: Bearer $WORKER_SHARED_SECRET" \
    -H "Content-Type: application/json" --data '{}' 2>/dev/null || true)"
  case "$HANDOFF_STATUS" in
    401)
      info "  server: up, but refuses the worker's secret (401), so it is restarted to pick it up"
      pkill -f "bun --env-file=../.env src/index.ts" >/dev/null 2>&1 || true
      sleep 1
      ;;
    404)
      info "  server: up, but has no /internal/routines/run (404: an older checkout), so it is restarted"
      pkill -f "bun --env-file=../.env src/index.ts" >/dev/null 2>&1 || true
      sleep 1
      ;;
  esac
fi
if ! identifies_as_openbot "$SERVER_PORT" server; then
  if [ "$ONE_COMPUTER_EACH" = "true" ]; then
    (cd server && nohup env \
      PORT="$SERVER_PORT" \
      COMPUTER_SUPERVISOR_URL="http://localhost:$SUPERVISOR_PORT" \
      SUPERVISOR_TOKEN="$SUPERVISOR_TOKEN" \
      COMPUTER_TOKEN="$COMPUTER_TOKEN" \
      WORKER_SHARED_SECRET="$WORKER_SHARED_SECRET" \
      bun --env-file=../.env src/index.ts >"$LOGS/server.log" 2>&1 </dev/null &)
  else
    (cd server && nohup env \
      PORT="$SERVER_PORT" \
      WORKER_SHARED_SECRET="$WORKER_SHARED_SECRET" \
      bun --env-file=../.env src/index.ts >"$LOGS/server.log" 2>&1 </dev/null &)
  fi
fi
wait_for_openbot "$SERVER_PORT" server

# The worker: a local stand-in for the routines CronJob, looping the same sweep
# (`offerDueRoutines`/`dispatchClaimedRoutines`) a cluster would run on a schedule instead. Started
# only now, because dispatching a claimed routine is one HTTP call to this server's own
# /internal/routines/run, and the wait_for above is what confirms that call has somewhere to land.
#
# Guarded by a pgrep check rather than an HTTP health check, the same way the restart guard above
# matches the server's own command line with `pkill -f`: the worker loop has no HTTP endpoint of its
# own to ask, so "is a matching process already running" is the only signal a rerun of this script
# has for "leave it alone."
#
# Launched from `$ROOT` with `bun worker/src/index.ts`, not `cd worker && bun src/index.ts`: on a
# Linux host, container processes are visible to `pgrep` too, and `server/Dockerfile`,
# `agent-computer/Dockerfile`, and `supervisor/Dockerfile` all run `bun src/index.ts` as their argv.
# The old pattern matched those containers, the guard false-positived, and the worker silently never
# started. `bun worker/src/index.ts` matches nothing else in the repo. Running from `$ROOT` is safe:
# relative imports resolve from the importing file, not from the process's cwd.
if ! pgrep -f "bun worker/src/index.ts" >/dev/null 2>&1; then
  WORKER_DATABASE_URL="$(setting DATABASE_URL postgres://openbot:openbot@localhost:5432/openbot)"
  (cd "$ROOT" && \
    nohup env \
      DATABASE_URL="$WORKER_DATABASE_URL" \
      SERVER_INTERNAL_URL="http://localhost:$SERVER_PORT" \
      WORKER_SHARED_SECRET="$WORKER_SHARED_SECRET" \
      bun worker/src/index.ts >"$LOGS/worker.log" 2>&1 </dev/null &)
  info "  worker: started (routine sweep loop)"
  sleep 1
  if ! pgrep -f "bun worker/src/index.ts" >/dev/null 2>&1; then
    red "  worker: did not stay up, check $LOGS/worker.log"
  fi
else
  info "  worker: already running"
fi

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
if ! identifies_as_openbot "$APP_PORT" app; then
  (cd app && nohup bun run dev --port "$APP_PORT" --strictPort >"$LOGS/app.log" 2>&1 </dev/null &)
fi
wait_for_openbot "$APP_PORT" app

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
  Routine sweep worker: $LOGS/worker.log
Stop the routine worker: pkill -f 'bun worker/src/index.ts'
Stop the Codex coworker: pkill -f 'bun agent-codex/src/index.ts'
Stop Docker services: docker compose down
  A Bot's computer is made by the supervisor rather than by compose, so it keeps running:
  docker rm -f \$(docker ps -q --filter label=openbot.supervisor=true)
  Its files and its browser profile are volumes and survive either way.
Stop host app/server: kill the processes using ports $APP_PORT and $SERVER_PORT
EOF
