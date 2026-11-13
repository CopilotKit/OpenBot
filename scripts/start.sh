#!/usr/bin/env bash
#
# Start the local OpenBot stack and verify each service answers as OpenBot.
# Safe to rerun: matching services are left running, and unrelated port holders are reported.

# Before anything else, and before the `set` line below, which is itself bash-only: this file is
# bash, and being read by `sh` used to end it with exit 1 and no output at all. See that file.
. "$(dirname "$0")/require-bash.sh"
# `holder`, `running` and `stop_matching`, which also work in Git Bash on Windows. See that file.
. "$(dirname "$0")/processes.sh"

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
if [ -f "$ROOT/.openbot-update-journal.json" ]; then
  # Only the exact in-flight updater operation may start before acceptance. A normal startup
  # must not run source whose migration/activation was interrupted.
  bun "$ROOT/scripts/update.ts" local assert-start --root "$ROOT"
fi
if [ -f "$ROOT/.openbot-release.json" ] && [ -z "${OPENBOT_UPDATE_OPERATION:-}" ]; then
  # Keep ordinary host restarts on the accepted build identity. Quoting each export treats
  # release strings as data; no shell text from metadata is evaluated.
  release_environment="$(bun "$ROOT/scripts/update.ts" local build-environment --root "$ROOT")"
  while IFS= read -r release_setting; do
    export "$release_setting"
  done <<< "$release_environment"
fi
# OPENBOT_LOG_DIR, for a second stack from the same checkout (a test run, say): it keeps its logs
# apart rather than over the logs of a stack a developer already has running.
LOGS="${OPENBOT_LOG_DIR:-$ROOT/.logs}"
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
    # `|| true`, BECAUSE A KEY THIS FUNCTION HAS A DEFAULT FOR IS ROUTINELY ABSENT FROM `.env`.
    #
    # That is the whole reason the second argument exists: `.env.example` does not list `APP_PORT`,
    # so a perfectly ordinary `.env` has no line for it. `grep` finding nothing is an exit status of
    # 1, `pipefail` makes it the pipeline's, and `set -e` then killed the script on the way to the
    # fallback that was sitting right there — before the first line of output, so the failure
    # named neither the key nor the file.
    #
    # Under bash that status did not escape the command substitution and the fallback won, which is
    # why this stood for as long as it did: the bug was invisible until somebody ran the script with
    # `sh`, where the same code exits 1 in silence. The refusal at the top of this file now names
    # that, and this closes the trap underneath it — an absent key takes the default in either
    # shell, which is what the argument always promised.
    value="$(grep -E "^$name=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true)"
  fi
  printf '%s' "${value:-$fallback}"
}

# The tag of the OpenBot images the server, worker, migrations, computer and supervisor run from:
# backend-images.env, unless the environment or .env names another build. Compose reads it as
# OPENBOT_BACKEND_TAG. Without it Compose would ask for a tag that does not exist.
BACKEND_TAG_PINNED="$(sed -n 's/^OPENBOT_BACKEND_TAG=//p' "$ROOT/backend-images.env" 2>/dev/null | tail -1 || true)"
OPENBOT_BACKEND_TAG="$(setting OPENBOT_BACKEND_TAG "$BACKEND_TAG_PINNED")"
if [ -z "$OPENBOT_BACKEND_TAG" ]; then
  printf '\033[31m%s\033[0m\n' "backend-images.env names no OPENBOT_BACKEND_TAG, so there is no OpenBot image to run."
  exit 1
fi
export OPENBOT_BACKEND_TAG

APP_PORT="$(setting APP_PORT 3010)"
SERVER_PORT="$(setting SERVER_PORT 3001)"
COMPUTER_PORT="$(setting COMPUTER_PORT 4100)"
BOT_PORT="$(setting BOT_PORT 4200)"
LANGGRAPH_PORT="$(setting LANGGRAPH_PORT 4201)"
BOT_PROVIDER="$(setting BOT_PROVIDER openai | tr '[:upper:]' '[:lower:]' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
SUPERVISOR_PORT="$(setting SUPERVISOR_PORT 4500)"
# Through `setting`, like every other key here, so `.env` counts as the comment above says and as
# docs/configuration.md tells people to rely on. Read from the environment alone, `false` in `.env`
# was ignored: the supervisor was still started and the server still told to use it.
ONE_COMPUTER_EACH="$(setting OPENBOT_ONE_COMPUTER_EACH true)"
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
# The laptop stack runs agent-langgraph on LANGGRAPH_PORT. The one-container image does not, so
# this default stays in the script rather than in .env: a `docker run --env-file .env` must not
# inherit a URL that points at a process the image does not contain.
#
# The personal edition runs its Personal Assistant inside the server, so it starts no Bot process and
# names no managed endpoint unless .env does. Its one computer carries only the one person's Bots, so
# it is started as theirs, which lets them record in a Bot's browser (agent-computer's person-access.ts).
EDITION="$(setting OPENBOT_EDITION team)"
if [ "$EDITION" = "personal" ]; then
  MANAGED_AGENT_AG_UI_URL="$(setting MANAGED_AGENT_AG_UI_URL "")"
  COMPUTER_PERSON_ID=personal
else
  MANAGED_AGENT_AG_UI_URL="$(setting MANAGED_AGENT_AG_UI_URL "http://localhost:${LANGGRAPH_PORT}/ag-ui")"
  COMPUTER_PERSON_ID=
fi
export MANAGED_AGENT_AG_UI_URL COMPUTER_PERSON_ID

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

# Does whatever holds this port answer as OpenBot, rather than merely answer?
#
# `curl -f` proves something is listening and returned 2xx. That is not the same claim, and the gap
# between them is not academic: any single-page app serves its own index.html for every path it does
# not recognise, so an unrelated dashboard sitting on a default port answers 200 to
# `/api/capabilities` as readily as this server does.
#
# When that happened here the cost was not a wrong answer, it was a wrong answer three stages later.
# `require_free_or_ours` reported "already up", the server was therefore never started, `wait_for`
# printed a green "server ready", and the run died at stage 3 parsing a mouthful of HTML as JSON —
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
  # `tr`, not `${name^^}`, which is bash 4. macOS ships bash 3.2, where that expansion is a "bad
  # substitution" and the run ended on it instead of on this hint.
  red "  Re-run with $(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')_PORT=<free port>, or stop that process yourself."
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
  red "  Log: $(log_of "$name")"
  exit 1
}

wait_for() {
  local url="$1" name="$2" tries="${3:-40}"
  for _ in $(seq 1 "$tries"); do
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1 && { green "  $name ready"; return 0; }
    sleep 1
  done
  red "  $name never became ready at $url"
  red "  Log: $(log_of "$name")"
  exit 1
}

# Where a service's output is: the app's in this run's log folder, everything else in Compose.
log_of() {
  case "$1" in
    app) printf '%s' "$LOGS/$1.log" ;;
    *) printf '%s' "docker compose logs $1" ;;
  esac
}

# A server an earlier start ran on the host from source, by the command it was started with.
stop_server_processes_for_restart() {
  stop_matching "bun --env-file=../.env src/production-entry.ts"
  stop_matching "bun --env-file=../.env src/index.ts"
}

echo
echo "OpenBot"
echo "======="

# Provision the installation's Composio project with the existing CLI sign-in, independently of
# Learning. The helper preserves supplied keys and Arcade. The server is started with the resulting
# .env below. Bun preserves exported values over .env, including empty strings. A child cannot change
# this shell's environment, so clear only blank overrides before setup and later server processes.
#
# Best-effort, like Learning below. It used to run bare under `set -e`, so a checkout with no key
# could not start at all while offline, signed out of the CLI, on a CLI without
# `integrations composio provision`, or against an Ops without the provisioning service. A failure
# is now the helper's one-line reason, and OpenBot starts with apps unavailable.
if [[ "${COMPOSIO_API_KEY:-}" != *[![:space:]]* ]]; then
  unset COMPOSIO_API_KEY
fi
COMPOSIO_BEFORE="$(setting COMPOSIO_API_KEY "")"
if COMPOSIO_LINE="$(bun scripts/setup-composio.ts 2>&1 | tail -1)"; then
  info "  $COMPOSIO_LINE"
else
  red "  Composio: apps are unavailable this run. ${COMPOSIO_LINE:-The Composio setup did not run.}"
fi
# Whatever the helper reported, a key that is new in .env must reach a server that is already up.
if [ -z "$COMPOSIO_BEFORE" ] && [ -n "$(setting COMPOSIO_API_KEY "")" ]; then
  SECRETS_ROTATED=true
fi

# The server runs in a container on the Compose network, below, so the Bots and the supervisor are
# told where it is before they start: the Bots call their tools back through it there.
OPENBOT_TOOL_URL="$(setting OPENBOT_TOOL_URL "http://server:3001/api/agent-tools/call")"
export OPENBOT_TOOL_URL
# Per-Bot computers on that network too, where the server can open them, or no supervisor at all.
if [ "$ONE_COMPUTER_EACH" = "true" ]; then
  COMPOSE_PROJECT="$(docker compose config --format json 2>/dev/null | bun -e 'process.stdout.write(JSON.parse(await Bun.stdin.text()).name ?? "")' 2>/dev/null || true)"
  COMPUTER_NETWORK="$(setting COMPUTER_NETWORK "${COMPOSE_PROJECT:-openbot}_default")"
  export COMPUTER_NETWORK
else
  export COMPUTER_SUPERVISOR_CONTAINER_URL=""
fi

info "1/4  Docker services"
SERVICES=(postgres)
if [ "$ONE_COMPUTER_EACH" = "true" ]; then
  SERVICES+=(supervisor)
fi
#
# Every selected Bot service, every run, whether or not it is already answering.
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
# The managed coworker uses LangGraph. The separate legacy sample only accepts OpenAI keys,
# so requiring it would prevent an Anthropic-only deployment from reaching its managed Bot.
if [ "$EDITION" = "personal" ]; then
  info "  agent-bot, agent-langgraph: skipped for the personal edition (its Bot runs in the server)"
elif [ "$BOT_PROVIDER" = "anthropic" ]; then
  info "  agent-bot: skipped for Anthropic (OpenAI-only sample)"
  SERVICES+=(agent-langgraph)
else
  SERVICES+=(agent-bot agent-langgraph)
fi

export SUPERVISOR_TOKEN COMPUTER_TOKEN WORKER_SHARED_SECRET
export COMPUTER_PORT BOT_PORT LANGGRAPH_PORT SUPERVISOR_PORT
# Quiet progress, because stdout is /dev/null while stderr is still the terminal. Seeing that
# terminal, newer Compose (v5 and later) picks its interactive build display and tries to draw it on
# stdout, and stops with "failed to get console: provided file is not a console". An environment
# variable rather than `--progress`, because a Compose too old to know the flag refuses it, and one
# too old to know the variable ignores it.
# The OpenBot images at OPENBOT_BACKEND_TAG, fetched on every start. `main` moves with every build,
# so a checkout of main runs the build that is current now, not a copy pulled weeks ago; a version
# tag never moves, so fetching it again only checks. Compose's own pull policy (`missing`) would keep
# whatever copy is here, so this pull asks for `always`. Offline, or with IMAGE_PULL_POLICY=never,
# the copies already on this machine are used.
if [ "${IMAGE_PULL_POLICY:-missing}" != never ]; then
  PULL=(migrate)
  if [ "$ONE_COMPUTER_EACH" = "true" ]; then
    PULL+=(supervisor)
  fi
  PULL+=(agent-computer)
  info "  OpenBot images: $OPENBOT_BACKEND_TAG"
  if ! IMAGE_PULL_POLICY=always COMPOSE_PROGRESS=quiet docker compose pull --quiet "${PULL[@]}" >"$LOGS/pull.log" 2>&1; then
    info "  Could not fetch the OpenBot images at $OPENBOT_BACKEND_TAG ($LOGS/pull.log). Using the copies on this machine."
  fi
fi
# `--build` for the Bots, which are built from this checkout. The server, computer and supervisor
# images were fetched above.
if ! COMPOSE_PROGRESS=quiet docker compose up -d --build "${SERVICES[@]}" >/dev/null; then
  red "  The Docker services did not start. The OpenBot images are at $OPENBOT_BACKEND_TAG (backend-images.env)."
  exit 1
fi
if ! docker compose run --rm migrate >"$LOGS/migrate.log" 2>&1; then
  red "  Migrations did not apply. The database is not the schema this server expects."
  red "  Log: $LOGS/migrate.log"
  exit 1
fi
wait_for "http://localhost:$COMPUTER_PORT/health" "agent-computer"
if [ "$EDITION" != "personal" ]; then
  if [ "$BOT_PROVIDER" != "anthropic" ]; then
    wait_for "http://localhost:$BOT_PORT/health" "agent-bot"
  fi
  wait_for "http://localhost:$LANGGRAPH_PORT/health" "agent-langgraph"
fi

for table in agent_profiles agent_preferences; do
  if ! docker compose exec -T postgres \
       psql -U openbot -d openbot -tAc "select to_regclass('public.$table')" 2>/dev/null \
       | grep -q "^$table$"; then
    red "  $table is missing. Run: docker compose --env-file backend-images.env --env-file .env run --rm migrate"
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
# The fallback stays outside the expansion: inside "${VAR:-...}" bash reads an apostrophe as an opening
# quote, which swallowed the script up to the next one and ran the words in later comments.
MANAGED_ENDPOINT_LINE="none (the personal edition's Bot runs in the server)"
green "  managed coworker endpoint: ${MANAGED_AGENT_AG_UI_URL:-$MANAGED_ENDPOINT_LINE}"

# Automatic Learning collects nothing until a container is assigned. The server assigns this
# project's `openbot` container on its own once it exists, but on an older Intelligence the runtime
# key it holds cannot create one. A CopilotKit CLI login can, whether or not a project is
# selected here, and so can INTELLIGENCE_SERVICE_TOKEN on a local evaluation install, so make sure the
# container exists before the server looks. Never fatal and never interactive: one line, whatever
# happens, and with nothing that can create it the line says exactly what to run.
LEARNING_CONTAINER="$(setting CPK_INTELLIGENCE_LEARNING_CONTAINER_ID "")"
LEARNING_AUTO_ASSIGN="$(setting OPENBOT_LEARNING_AUTO_ASSIGN true)"
if [ -z "$LEARNING_CONTAINER" ] && [ "$LEARNING_AUTO_ASSIGN" != "false" ] \
   && [ "$LEARNING_AUTO_ASSIGN" != "0" ] && { [ -n "$(setting CPK_INTELLIGENCE_API_KEY "")" ] || [ -n "$(setting INTELLIGENCE_API_KEY "")" ]; }; then
  LEARNING_LINE="$(bun scripts/setup-learning.ts --non-interactive 2>>"$LOGS/learning-setup.log" | tail -1 || true)"
  info "  ${LEARNING_LINE:-Automatic Learning: the container check did not run. Log: $LOGS/learning-setup.log}"
fi

# The personal edition's own browser shows in the page, on the one computer its Bots run on, as in
# OpenBot Desktop: the server offers it there whenever OPENBOT_BROWSER_URL names no other.

info "2/4  Server"
# The server and the routine worker run from the OpenBot server image, as Compose services, and the
# app below is this checkout's, served by Vite with its `/api` proxied to the server's port.
#
# A server an earlier start ran on the host from source, still holding the port: stopped, with its
# routine worker, the way a restart always stopped them, so the container can have the port. Only a
# host `bun` that answers as OpenBot; anything else on the port is reported and left alone.
if [ -z "$(docker compose ps -q server 2>/dev/null)" ]; then
  SERVER_HOLDER="$(holder "$SERVER_PORT")"
  if [[ "$SERVER_HOLDER" == bun* ]] && identifies_as_openbot "$SERVER_PORT" server; then
    info "  server: stopping the one an earlier start ran on the host ($SERVER_HOLDER)"
    stop_server_processes_for_restart
    stop_matching "bun worker/src/index.ts"
    sleep 1
  fi
  require_free_or_ours "$SERVER_PORT" server
fi

# The folder the server's sign-in file is mounted from, which Compose does not create (see
# docker-compose.yml). Empty unless somebody signs a model in with OAuth.
mkdir -p "$ROOT/.openbot"

# What the server is started with: `.env`, with whatever this environment sets winning over it, as it
# did when the server ran on the host and Bun read the two that way. Written to a private file for
# Compose, which reads it when it creates the container, and removed straight after.
SERVER_ENV="$(mktemp "${TMPDIR:-/tmp}/openbot-server-env.XXXXXX")"
trap 'rm -f "$SERVER_ENV"' EXIT
# `--no-env-file`: the file is the argument, and its own reading of the environment must not be
# `.env` loaded a second time behind it.
bun --no-env-file scripts/server-env.ts "$ROOT/.env" "$SERVER_ENV"
export OPENBOT_SERVER_ENV_FILE="$SERVER_ENV"

# Addresses on this machine, as the server's container reaches them. A loopback address in `.env`
# names the container itself in there, so each one that needs it gets a container address of its
# own, unless one is already set: `host.docker.internal`, which Compose maps to this machine.
in_container() {
  printf '%s' "$1" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://)(localhost|127\.0\.0\.1|\[::1\])([:/]|$)#\1host.docker.internal\3#'
}
for pair in OPENAI_BASE_URL:OPENAI_CONTAINER_BASE_URL \
            INTELLIGENCE_API_URL:INTELLIGENCE_CONTAINER_API_URL \
            INTELLIGENCE_GATEWAY_WS_URL:INTELLIGENCE_CONTAINER_GATEWAY_WS_URL \
            PICKED_HARNESS_URL:PICKED_HARNESS_CONTAINER_URL; do
  host_name="${pair%%:*}" container_name="${pair##*:}"
  if [ -z "$(setting "$container_name" "")" ] && [ -n "$(setting "$host_name" "")" ]; then
    export "$container_name=$(in_container "$(setting "$host_name" "")")"
  fi
done
# An agent somebody registers on their own loopback is dialled on this machine, not in the container.
export OPENBOT_THIS_MACHINE_CONTAINER_HOST="${OPENBOT_THIS_MACHINE_CONTAINER_HOST:-host.docker.internal}"
# The app is this checkout's, on APP_PORT, so the server's own copy of it is published nowhere fixed.
export SERVER_APP_PORT=""

# Every run, like the services above: Compose recreates the containers when their settings or the
# image changed, and leaves them alone otherwise. A secret minted this run is a change it is told about.
RECREATE=()
if [ "$SECRETS_ROTATED" = "true" ]; then
  info "  a secret was generated this run, so the server is restarted to pick it up"
  RECREATE=(--force-recreate)
fi
if ! COMPOSE_PROGRESS=quiet docker compose up -d --no-deps ${RECREATE[@]+"${RECREATE[@]}"} server worker >/dev/null; then
  red "  The server did not start from ghcr.io/copilotkit/openbot-server:$OPENBOT_BACKEND_TAG."
  red "  Log: docker compose logs server"
  exit 1
fi
rm -f "$SERVER_ENV"
unset OPENBOT_SERVER_ENV_FILE
wait_for_openbot "$SERVER_PORT" server 90
info "  worker: running (routine sweep loop)"

info "3/4  Runtime health"
INFO="$(curl -fsS --max-time 8 "http://localhost:$SERVER_PORT/api/copilotkit/info")"
# Read with Bun, which every run of this script already needs, rather than python3, which not every
# machine has. On Windows `python3` is usually the Microsoft Store alias, which prints "Python was not
# found" and exits 49, so the run stopped here with the server and worker up and the app never
# started.
bun run - "$INFO" <<'JS'
const info = JSON.parse(process.argv[2]);
const status = info.licenseStatus;
const agents = Object.keys(info.agents ?? {});
if (status !== "valid") {
  console.log(`\x1b[31m  licence is '${status}', not 'valid'.\x1b[0m`);
  console.log("\x1b[31m  Check CPK_INTELLIGENCE_API_KEY (or INTELLIGENCE_API_KEY): npx copilotkit@latest login && npx copilotkit@latest project select\x1b[0m");
  console.log("\x1b[31m  See README.md for Intelligence setup.\x1b[0m");
  process.exit(1);
}
if (agents.length === 0) {
  console.log("\x1b[31m  No Bots registered.\x1b[0m");
  process.exit(1);
}
console.log(`\x1b[32m  licence valid · mode ${info.mode} · Bots: ${agents.join(", ")}\x1b[0m`);
JS

info "4/4  App"
require_free_or_ours "$APP_PORT" app
if ! identifies_as_openbot "$APP_PORT" app; then
  (cd app && bun run dev --port "$APP_PORT" --strictPort) >"$LOGS/app.log" 2>&1 &
fi
wait_for_openbot "$APP_PORT" app

cat <<EOF

$(green "Ready. http://localhost:$APP_PORT")

Next steps:

  - Direct Bot chat:       http://localhost:$APP_PORT/bot
  - Bots:                  http://localhost:$APP_PORT/bots
  - Audit trail:           http://localhost:$APP_PORT/admin/audit
  - Boundaries/policy:     http://localhost:$APP_PORT/admin/boundaries
  - Setup docs:            README.md
  - Configuration docs:    docs/configuration.md

Try:

  1. Open /bot and ask: Open news.ycombinator.com and tell me the top story.
  2. Create a Bot in /bots and start a channel with it.
  3. Review browser/file actions in /admin/audit.
  4. Add a deny rule in /admin/boundaries, then retry the same action.

Logs: $LOGS (the app)
  The server and the routine worker: docker compose logs server worker
  Images: ghcr.io/copilotkit/openbot-server:$OPENBOT_BACKEND_TAG and the rest, from backend-images.env

Stop all of it: bash scripts/stop.sh
  The app, the server and worker, the Docker services, and each Bot's computer, which compose
  does not own because the supervisor makes it. Pass --keep-computers to leave the browsers signed
  in. Nothing is deleted either way: the database, the files and the browser profiles are volumes.
EOF
