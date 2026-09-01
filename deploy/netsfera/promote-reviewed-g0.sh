#!/usr/bin/env bash
# Promote one verified review artifact.  This is deliberately fail-fast: it is
# intended to be the only state-changing command executed on the bot host.
set -Eeuo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <bundle-path> <bundle-sha256> <advertised-ref> <target-commit>" >&2
  exit 64
fi

bundle_path="$1"
expected_bundle_sha256="$2"
advertised_ref="$3"
target_commit="$4"

source_directory="${OPENBOT_SOURCE_DIR:-/opt/openbot/source}"
incoming_directory="${OPENBOT_INCOMING_DIR:-/root/openbot-incoming}"
project_name="${OPENBOT_COMPOSE_PROJECT:-openbot}"
base_env_file="${OPENBOT_BASE_ENV_FILE:-/opt/openbot/.env}"
phase2_env_file="${OPENBOT_PHASE2_ENV_FILE:-/etc/netsfera/bot-zero-trust/erp-phase2.env}"
base_compose_file="${OPENBOT_BASE_COMPOSE_FILE:-/opt/openbot/docker-compose.yml}"
supervisor_compose_file="${OPENBOT_SUPERVISOR_COMPOSE_FILE:-/opt/openbot/docker-compose.browser-supervisor.yml}"
phase2_compose_file="${OPENBOT_PHASE2_COMPOSE_FILE:-/etc/netsfera/bot-zero-trust/erp-phase2.yml}"
g0_overlay_file="${OPENBOT_G0_OVERLAY_FILE:-${source_directory}/deploy/netsfera/docker-compose.erp-agent.yml}"
expected_owner="${OPENBOT_EXPECTED_BUNDLE_OWNER:-root:root}"

umask 077
temporary_directory="$(mktemp -d "${incoming_directory}/g0-promotion.XXXXXX")"
base_render="${temporary_directory}/base.json"
candidate_render="${temporary_directory}/candidate.json"
test_source_directory="${temporary_directory}/test-source"
evidence_file="${incoming_directory}/g0-promotion-${target_commit}.evidence"
rollback_ready=0
success=0

compose_base=(
  docker compose -p "$project_name"
  --env-file "$base_env_file"
  --env-file "$phase2_env_file"
  -f "$base_compose_file"
  -f "$supervisor_compose_file"
  -f "$phase2_compose_file"
)

file_owner_mode() {
  if stat -c '%U:%G %a' "$1" >/dev/null 2>&1; then
    stat -c '%U:%G %a' "$1"
  else
    stat -f '%Su:%Sg %Lp' "$1"
  fi
}

clean_up_private_files() {
  rm -rf "$temporary_directory"
  rm -f "$bundle_path"
}

restore_previous_state() {
  local status="$1"
  trap - ERR HUP INT TERM
  if [ "$rollback_ready" -eq 1 ]; then
    echo "promotion failed; restoring recorded OpenBot source and image" >&2
    docker image tag "$rollback_image_tag" "$rollback_image_reference" >/dev/null 2>&1 || true
    git -C "$source_directory" checkout --detach "$rollback_source_revision" >/dev/null 2>&1 || true
    "${compose_base[@]}" up -d --no-build >/dev/null 2>&1 || true
  fi
  exit "$status"
}

on_exit() {
  local status=$?
  clean_up_private_files
  if [ "$success" -ne 1 ]; then
    restore_previous_state "$status"
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

if [ ! -f "$bundle_path" ]; then
  echo "reviewed bundle is missing" >&2
  exit 65
fi
if [ ! -d "$source_directory/.git" ]; then
  echo "OpenBot source checkout is missing" >&2
  exit 65
fi
if ! [[ "$expected_bundle_sha256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "reviewed bundle SHA-256 has invalid format" >&2
  exit 65
fi
actual_bundle_sha256="$(sha256sum "$bundle_path" | awk '{ print $1 }')"
if [ "$actual_bundle_sha256" != "$expected_bundle_sha256" ]; then
  echo "reviewed bundle SHA-256 mismatch" >&2
  exit 65
fi
if [ "$(file_owner_mode "$bundle_path")" != "${expected_owner} 600" ]; then
  echo "reviewed bundle owner or mode is not approved" >&2
  exit 65
fi
git -C "$source_directory" bundle verify "$bundle_path" >/dev/null
advertised_commit="$(git -C "$source_directory" bundle list-heads "$bundle_path" | awk -v ref="$advertised_ref" '$2 == ref { print $1 }')"
if [ "$advertised_commit" != "$target_commit" ]; then
  echo "reviewed bundle does not advertise the requested commit" >&2
  exit 65
fi

if ! g0_grants="$("${compose_base[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U openbot -d openbot -At -F $'\t' \
  -c "SELECT agent_id, kind, ref FROM plugin_grants WHERE agent_id IN ('jefe-erp', 'recolector-documentos') ORDER BY agent_id, kind, ref")"; then
  echo "could not enumerate persisted G0 grants" >&2
  exit 65
fi
if [ -n "$g0_grants" ]; then
  echo "persisted grants exist for a locked Netsfera Bot" >&2
  exit 65
fi

# Capture rollback state before any checkout, build, or Compose mutation.
rollback_source_revision="$(git -C "$source_directory" rev-parse HEAD)"
rollback_image_reference="$("${compose_base[@]}" config --format json | jq -er '.services.openbot.image')"
rollback_container_id="$("${compose_base[@]}" ps -q openbot)"
if [ -z "$rollback_container_id" ]; then
  echo "the existing OpenBot container cannot be resolved" >&2
  exit 65
fi
rollback_running_image_id="$(docker inspect --format '{{.Image}}' "$rollback_container_id")"
rollback_image_tag="${rollback_image_reference}-g0-rollback-${target_commit:0:12}"
docker image tag "$rollback_running_image_id" "$rollback_image_tag"
rollback_ready=1

git -C "$source_directory" fetch --no-tags "$bundle_path" "${advertised_ref}:refs/heads/g0-reviewed-artifact"
if [ "$(git -C "$source_directory" rev-parse refs/heads/g0-reviewed-artifact)" != "$target_commit" ]; then
  echo "fetched review artifact did not resolve to the target commit" >&2
  exit 65
fi
git -C "$source_directory" cat-file -e "${target_commit}^{commit}"
git -C "$source_directory" checkout --detach "$target_commit"
if [ -n "$(git -C "$source_directory" status --porcelain)" ]; then
  echo "reviewed OpenBot checkout is not clean" >&2
  exit 65
fi

# Bun is never installed on the host.  The throw-away copy isolates test output
# from the checkout that is later built and promoted.
git clone --quiet --no-hardlinks "$source_directory" "$test_source_directory"
git -C "$test_source_directory" checkout --detach "$target_commit"
docker run --rm \
  -v "${test_source_directory}:/source:rw" \
  -w /source \
  oven/bun:1.3.14 \
  sh -ceu 'bun install --frozen-lockfile && bun test server/tests/computer-policy.test.ts server/tests/computer-access.test.ts server/tests/computer-stream-access.test.ts server/tests/app-build-tenant-config.test.ts server/tests/netsfera-overlay.test.ts server/tests/verify-rendered-overlay-script.test.ts server/tests/reviewed-bundle-script.test.ts server/tests/reviewed-promotion-script.test.ts app/tests/computer-access.test.ts && bun run --cwd app typecheck'

"${compose_base[@]}" config --format json >"$base_render"
"${compose_base[@]}" -f "$g0_overlay_file" config --format json >"$candidate_render"
chmod 600 "$base_render" "$candidate_render"
"${source_directory}/deploy/netsfera/verify-rendered-overlay.sh" "$base_render" "$candidate_render" >/dev/null
candidate_hash="$(sha256sum "$candidate_render" | awk '{ print $1 }')"

if [ "$(sha256sum "$candidate_render" | awk '{ print $1 }')" != "$candidate_hash" ]; then
  echo "private candidate render changed before build" >&2
  exit 65
fi
docker compose -p "$project_name" -f "$candidate_render" build openbot
candidate_image_reference="$(jq -er '.services.openbot.image' "$candidate_render")"
candidate_image_id="$(docker image inspect --format '{{.Id}}' "$candidate_image_reference")"
docker run --rm --entrypoint sh "$candidate_image_id" -ceu '
  grep -R -F -q "NETSFERA ERP" /app/app/dist 2>/dev/null &&
  grep -R -F -q "netsfera" /app/app/dist 2>/dev/null
'
if [ "$(git -C "$source_directory" rev-parse HEAD)" != "$target_commit" ] || [ -n "$(git -C "$source_directory" status --porcelain)" ]; then
  echo "reviewed OpenBot checkout changed after build" >&2
  exit 65
fi
if [ "$(sha256sum "$candidate_render" | awk '{ print $1 }')" != "$candidate_hash" ]; then
  echo "private candidate render changed before apply" >&2
  exit 65
fi

docker compose -p "$project_name" -f "$candidate_render" up -d --no-build
running_container_id="$(docker compose -p "$project_name" -f "$candidate_render" ps -q openbot)"
if [ -z "$running_container_id" ]; then
  echo "the promoted OpenBot container cannot be resolved" >&2
  exit 65
fi
running_image_id="$(docker inspect --format '{{.Image}}' "$running_container_id")"
if [ "$running_image_id" != "$candidate_image_id" ]; then
  echo "the promoted OpenBot container image does not match the reviewed build" >&2
  exit 65
fi
for _ in $(seq 1 30); do
  if [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$running_container_id")" = "healthy" ]; then
    break
  fi
  sleep 2
done
if [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$running_container_id")" != "healthy" ]; then
  echo "the promoted OpenBot container did not become healthy" >&2
  exit 65
fi

{
  printf 'target_commit=%s\n' "$target_commit"
  printf 'candidate_render_sha256=%s\n' "$candidate_hash"
  printf 'built_image_id=%s\n' "$candidate_image_id"
  printf 'rollback_source_revision=%s\n' "$rollback_source_revision"
  printf 'rollback_image_reference=%s\n' "$rollback_image_reference"
  printf 'rollback_image_tag=%s\n' "$rollback_image_tag"
} >"$evidence_file"
chmod 600 "$evidence_file"
success=1
printf 'promotion complete; private evidence: %s; rollback source: %s; rollback image tag: %s\n' \
  "$evidence_file" "$rollback_source_revision" "$rollback_image_tag"
