#!/usr/bin/env bash
#
# A real Intelligence for OpenBot's tests: throwaway, self-hosted, on loopback.
#
# OpenBot keeps its Bots, configuration, policy, vault, files, memory, audit, schedules,
# conversations and people in Intelligence, so the tests that touch them run against a real one and
# never a stand-in (server/tests/support/bots.ts). This starts Intelligence's published
# single-container image with a Postgres and a Redis of its own, makes one organization with a
# project for each test key, and checks that every capability OpenBot keeps there answers.
#
# The image is public, so a pull request from a fork gets the same Intelligence as one from this
# repository, with no secret: the keys are made up, for a database this makes and throws away.
#
#   scripts/test-intelligence.sh up     start it, or check the one already running, and print the
#                                       TEST_INTELLIGENCE_* variables that name it
#   scripts/test-intelligence.sh down   remove its containers and network
#
# Locally: `export $(scripts/test-intelligence.sh up)`, then `bun test`.
#
# What it reads, all optional:
#   INTELLIGENCE_IMAGE               the image, instead of the one pinned below: one built from an
#                                    Intelligence checkout, say (`docker build -f Dockerfile.composite`).
#   TEST_INTELLIGENCE_PORT           the first of the four loopback ports it binds, in order
#                                    Postgres, Redis, the API, the realtime gateway (default 7480).
#   TEST_INTELLIGENCE_API_KEY(_2)    the two projects' keys. When CI's job sets them, as it sets
#                                    DATABASE_URL, they are made to work; unset, they are made up.
#   TEST_INTELLIGENCE_API_URL, _GATEWAY_WS_URL, _DATABASE_URL, _REDIS_URL
#                                    when set, must be where this starts it, or it stops and says so.
#   TEST_INTELLIGENCE_NAME           the containers' prefix and the network's name
#                                    (default openbot-test-intelligence).

# Before anything else, and before the `set` line below, which is itself bash-only. See that file.
. "$(dirname "$0")/require-bash.sh"

set -euo pipefail

# The Intelligence OpenBot's tests and CI run against, by digest. It must serve every capability in
# CAPABILITIES below. This is a release-validation build of CopilotKit/Intelligence#2210, not a
# release: repin it to the Intelligence release that contains #2210 before CopilotKit/OpenBot#987
# merges.
DEFAULT_IMAGE="ghcr.io/copilotkit/intelligence/composite:0.15.2-validation.c2e70fa5fda4@sha256:3659cf2c3a5c481e571484931203c390f5e8115ea07879a14eb4c98c8c69a098"
INTELLIGENCE_IMAGE="${INTELLIGENCE_IMAGE:-$DEFAULT_IMAGE}"
NAME="${TEST_INTELLIGENCE_NAME:-openbot-test-intelligence}"
PORT="${TEST_INTELLIGENCE_PORT:-7480}"
PG="$NAME-postgres"
REDIS="$NAME-redis"
APP="$NAME"
NETWORK="$NAME"

API_URL="http://127.0.0.1:$((PORT + 2))"
GATEWAY_WS_URL="ws://127.0.0.1:$((PORT + 3))"
DATABASE_URL="postgresql://intelligence:intelligence@127.0.0.1:${PORT}/intelligence_app"
REDIS_URL="redis://127.0.0.1:$((PORT + 1))"

log() { printf '[test-intelligence] %s\n' "$*" >&2; }
fail() {
  printf '[test-intelligence] %s\n' "$*" >&2
  exit 1
}

# Every capability OpenBot keeps in Intelligence, each read once with the first project's key. An
# Intelligence that answers but lacks one of them would fail hundreds of tests one at a time; this
# names it once.
CAPABILITIES=(
  agents
  agent-access
  policy/capability-rules
  vault/secrets
  tool-servers
  connections
  files
  conversations
  delivery-bindings
  directory/people
  schedules/routines
  audit/events
)

down() {
  docker rm -f "$APP" "$REDIS" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}

wait_for() {
  local tries="$1"
  shift
  for _ in $(seq 1 "$tries"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# A variable the caller set must say what this starts, or the tests would be pointed elsewhere.
agrees() {
  local name="$1" expected="$2" actual="${!1:-}"
  [ -z "$actual" ] || [ "$actual" = "$expected" ] ||
    fail "$name is $actual, but this starts Intelligence at $expected. Set TEST_INTELLIGENCE_PORT to match, or unset $name."
}

sql() {
  docker exec -i -e PGOPTIONS=-cclient_min_messages=warning "$PG" \
    psql -q -tA -v ON_ERROR_STOP=1 -U intelligence -d intelligence_app
}

sha256() { printf '%s' "$1" | openssl dgst -sha256 | awk '{print $NF}'; }

# A project in the test organization, and KEY as its key. Intelligence keeps only a hash of a key's
# long part, so the key's hash is written on every run rather than compared.
project_with_key() {
  local slug="$1" key="$2" short long
  IFS=_ read -r _ short long <<<"$key"
  [[ "$key" =~ ^cpk_[A-Za-z0-9]+_[A-Za-z0-9]+$ ]] ||
    fail "A test key must look like cpk_<short>_<long>, letters and digits only."
  sql <<SQL >/dev/null || fail "Could not make the test organization, its ${slug} project and its key in Intelligence's database."
INSERT INTO cpki.organizations (id, slug, name)
VALUES ('openbot-tests', 'openbot-tests', 'OpenBot tests')
ON CONFLICT (id) DO NOTHING;
INSERT INTO cpki.control_plane_users (id, organization_id)
VALUES ('openbot-tests', 'openbot-tests')
ON CONFLICT (id) DO NOTHING;
INSERT INTO cpki.projects (organization_id, slug, name, created_by_user_id)
SELECT 'openbot-tests', '${slug}', 'OpenBot tests, ${slug} project', 'openbot-tests'
 WHERE NOT EXISTS (SELECT 1 FROM cpki.projects
                    WHERE organization_id = 'openbot-tests' AND slug = '${slug}' AND deleted_at IS NULL);
UPDATE cpki.api_keys SET long_token_hash = '$(sha256 "$long")', updated_at = now()
 WHERE short_token = '${short}' AND deleted_at IS NULL;
INSERT INTO cpki.api_keys
  (organization_id, project_id, created_by_user_id, name, description, short_token, long_token_hash)
SELECT 'openbot-tests', p.id, 'openbot-tests', 'OpenBot tests', 'Made by scripts/test-intelligence.sh',
       '${short}', '$(sha256 "$long")'
  FROM cpki.projects p
 WHERE p.organization_id = 'openbot-tests' AND p.slug = '${slug}' AND p.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM cpki.api_keys WHERE short_token = '${short}' AND deleted_at IS NULL);
SQL
}

up() {
  agrees TEST_INTELLIGENCE_API_URL "$API_URL"
  agrees TEST_INTELLIGENCE_GATEWAY_WS_URL "$GATEWAY_WS_URL"
  agrees TEST_INTELLIGENCE_DATABASE_URL "$DATABASE_URL"
  agrees TEST_INTELLIGENCE_REDIS_URL "$REDIS_URL"
  local key="${TEST_INTELLIGENCE_API_KEY:-cpk_sOBTEST1_$(openssl rand -hex 16)}"
  local key2="${TEST_INTELLIGENCE_API_KEY_2:-cpk_sOBTEST2_$(openssl rand -hex 16)}"
  [ "${key#cpk_}" != "$key" ] && [ "${key2#cpk_}" != "$key2" ] ||
    fail "TEST_INTELLIGENCE_API_KEY and TEST_INTELLIGENCE_API_KEY_2 must each look like cpk_<short>_<long>."
  [ "$(cut -d_ -f2 <<<"$key")" != "$(cut -d_ -f2 <<<"$key2")" ] ||
    fail "TEST_INTELLIGENCE_API_KEY and TEST_INTELLIGENCE_API_KEY_2 must name two projects, so two keys."

  # A container left from another image is replaced, never reused: the tests run against the
  # Intelligence named, on a database its own migrations made.
  if docker container inspect "$APP" >/dev/null 2>&1 &&
    [ "$(docker container inspect -f '{{.Config.Image}}' "$APP")" != "$INTELLIGENCE_IMAGE" ]; then
    log "$APP runs another image; starting again from an empty database"
    down
  fi
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null

  if ! docker container inspect "$PG" >/dev/null 2>&1; then
    docker run -d --name "$PG" --network "$NETWORK" -p "127.0.0.1:${PORT}:5432" \
      -e POSTGRES_USER=intelligence -e POSTGRES_PASSWORD=intelligence -e POSTGRES_DB=intelligence_app \
      pgvector/pgvector:0.8.2-pg16 >/dev/null
  fi
  if ! docker container inspect "$REDIS" >/dev/null 2>&1; then
    docker run -d --name "$REDIS" --network "$NETWORK" -p "127.0.0.1:$((PORT + 1)):6379" \
      redis:7-alpine >/dev/null
  fi
  wait_for 60 docker exec "$PG" pg_isready -U intelligence -d intelligence_app ||
    fail "Intelligence's Postgres did not become ready within 120s."
  wait_for 30 docker exec "$REDIS" redis-cli ping ||
    fail "Intelligence's Redis did not become ready within 60s."

  if ! docker container inspect "$APP" >/dev/null 2>&1; then
    log "starting $INTELLIGENCE_IMAGE"
    # Pulled unless it is already here, so an image built locally from a branch runs as it is.
    docker image inspect "$INTELLIGENCE_IMAGE" >/dev/null 2>&1 ||
      docker pull -q "$INTELLIGENCE_IMAGE" >/dev/null ||
      fail "Could not pull $INTELLIGENCE_IMAGE."
    # Self-hosted, as a customer runs it. Every secret it needs is made for this run and dies with it.
    docker run -d --name "$APP" --network "$NETWORK" \
      -p "127.0.0.1:$((PORT + 2)):4201" -p "127.0.0.1:$((PORT + 3)):4401" \
      -e DATABASE_URL="postgresql://intelligence:intelligence@${PG}:5432/intelligence_app" \
      -e REDIS_URL="redis://${REDIS}:6379" \
      -e INTELLIGENCE_DEPLOYMENT_MODE=self_hosted \
      -e AUTH_SECRET="$(openssl rand -hex 32)" \
      -e AUTH_TRUST_HOST=true \
      -e RUNNER_AUTH_SECRET="$(openssl rand -hex 32)" \
      -e SECRET_KEY_BASE="$(openssl rand -hex 48)" \
      -e PHX_HOST=127.0.0.1 \
      -e LOG_LEVEL=info \
      -e APP_VAULT_MASTER_KEY="$(openssl rand -base64 32)" \
      -e APP_VAULT_MASTER_KEY_ID=openbot-tests-1 \
      "$INTELLIGENCE_IMAGE" >/dev/null
  fi

  if ! wait_for 120 curl -fsS --max-time 5 "$API_URL/api/health/live"; then
    docker logs --tail 80 "$APP" >&2 || true
    fail "Intelligence's API did not answer at $API_URL within 240s."
  fi
  if ! wait_for 60 bash -c "exec 3<>/dev/tcp/127.0.0.1/$((PORT + 3))"; then
    docker logs --tail 80 "$APP" >&2 || true
    fail "Intelligence's realtime gateway did not listen at $GATEWAY_WS_URL within 120s."
  fi

  project_with_key first "$key"
  project_with_key second "$key2"

  local missing=() status
  for path in "${CAPABILITIES[@]}"; do
    # Bounded: an Intelligence without the route can hold the request open rather than refuse it.
    status="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" \
      "$API_URL/api/${path}?limit=1")" || true
    case "$status" in
    200) ;;
    "" | 000) missing+=("/api/${path} (no answer)") ;;
    *) missing+=("/api/${path} (HTTP ${status})") ;;
    esac
  done
  [ "${#missing[@]}" -eq 0 ] ||
    fail "$INTELLIGENCE_IMAGE runs, but does not serve what OpenBot keeps in Intelligence: ${missing[*]}. Pin an Intelligence that does (DEFAULT_IMAGE in scripts/test-intelligence.sh)."

  printf '%s\n' \
    "TEST_INTELLIGENCE_API_URL=$API_URL" \
    "TEST_INTELLIGENCE_GATEWAY_WS_URL=$GATEWAY_WS_URL" \
    "TEST_INTELLIGENCE_API_KEY=$key" \
    "TEST_INTELLIGENCE_API_KEY_2=$key2" \
    "TEST_INTELLIGENCE_DATABASE_URL=$DATABASE_URL" \
    "TEST_INTELLIGENCE_REDIS_URL=$REDIS_URL"
  log "ready: $INTELLIGENCE_IMAGE at $API_URL"
}

case "${1:-}" in
up) up ;;
down) down ;;
*)
  echo "usage: $0 up | down" >&2
  exit 2
  ;;
esac
