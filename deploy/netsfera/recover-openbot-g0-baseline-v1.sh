#!/usr/bin/env bash
# Re-establish an exact, semantically reviewed G0 image reference after an OCI
# config-digest/descriptor mismatch. This is an explicit incident operation.
set -euo pipefail
set +x

[[ "$#" -eq 2 ]] || { printf '%s\n' 'usage: recover-openbot-g0-baseline-v1.sh <expected-live-container-id> <expected-live-config-id>' >&2; exit 64; }
readonly expected_live_container_id="$1" expected_live_config_id="$2"
readonly accepted_g0_source_commit='ff5aa7ebd8ac798887017bfa1f5a471483b0c499'
readonly source_directory="${OPENBOT_SOURCE_DIR:-/opt/openbot/source}"
readonly incoming_directory="${OPENBOT_INCOMING_DIR:-/root/openbot-incoming}"
readonly project_name="${OPENBOT_COMPOSE_PROJECT:-openbot}"
readonly base_env_file="${OPENBOT_BASE_ENV_FILE:-/opt/openbot/.env}"
readonly phase2_env_file="${OPENBOT_PHASE2_ENV_FILE:-/etc/netsfera/bot-zero-trust/erp-phase2.env}"
readonly base_compose_file="${OPENBOT_BASE_COMPOSE_FILE:-/opt/openbot/docker-compose.yml}"
readonly supervisor_compose_file="${OPENBOT_SUPERVISOR_COMPOSE_FILE:-/opt/openbot/docker-compose.browser-supervisor.yml}"
readonly phase2_compose_file="${OPENBOT_PHASE2_COMPOSE_FILE:-/opt/openbot/docker-compose.erp-phase2.yml}"
readonly g0_overlay_file="${OPENBOT_G0_OVERLAY_FILE:-${source_directory}/deploy/netsfera/docker-compose.erp-agent.yml}"
readonly deployment_lock_file="${OPENBOT_DEPLOYMENT_LOCK_FILE:-/var/lock/openbot-deployment.lock}"
readonly activation_marker="${OPENBOT_G1_ACTIVATION_MARKER:-/etc/netsfera/bot-zero-trust/enable-openbot-g1}"
readonly activation_manifest="${OPENBOT_G1_ACTIVATION_MANIFEST:-/etc/netsfera/bot-zero-trust/openbot-g1-activation.manifest}"
readonly health_timeout="${OPENBOT_RECOVERY_HEALTH_TIMEOUT_SECONDS:-120}"
readonly bun_test_image='oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4'
readonly compose_helper="${OPENBOT_COMPOSE_HELPER:-/usr/local/lib/netsfera/openbot-compose-v1.sh}"

[[ "$expected_live_container_id" =~ ^[a-f0-9]{64}$ && "$expected_live_config_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 65
[[ "$health_timeout" =~ ^[1-9][0-9]*$ ]] || exit 65
for command in awk chmod date docker flock git grep jq mktemp od sha256sum stat tr; do command -v "$command" >/dev/null || exit 65; done
[[ -d "$source_directory/.git" && -d "$incoming_directory" ]] || exit 65

umask 077
owner_mode() { if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then stat -c '%u:%g %a' "$1"; else stat -f '%u:%g %Lp' "$1"; fi; }
lock_inode() { if stat -Lc '%d:%i' "$1" >/dev/null 2>&1; then stat -Lc '%d:%i' "$1"; else stat -f '%d:%i' "$1"; fi; }
activation_state_absent() { [[ ! -e "$activation_marker" && ! -L "$activation_marker" && ! -e "$activation_manifest" && ! -L "$activation_manifest" ]]; }
container_health() { docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$1"; }
compose_base() {
  "$compose_helper" --lock-held-fd 9 --reviewed-controller -p "$project_name" --env-file "$base_env_file" --env-file "$phase2_env_file" \
    -f "$base_compose_file" -f "$supervisor_compose_file" -f "$phase2_compose_file" "$@"
}
wait_healthy() {
  local container_id="$1" status deadline
  deadline=$(( $(date +%s) + health_timeout ))
  while :; do
    status="$(container_health "$container_id" 2>/dev/null || printf missing)"
    [[ "$status" == healthy ]] && return 0
    [[ "$status" == unhealthy || "$status" == missing ]] && return 1
    [[ "$(date +%s)" -lt "$deadline" ]] || return 1
    sleep 1
  done
}

[[ -f "$deployment_lock_file" && ! -L "$deployment_lock_file" && "$(owner_mode "$deployment_lock_file")" == '0:0 600' ]] || exit 65
exec 9>"$deployment_lock_file"
flock -n 9 || exit 75
[[ "$(lock_inode "$deployment_lock_file")" == "$(lock_inode "/proc/$$/fd/9")" ]] || exit 65
activation_state_absent || { printf '%s\n' 'G0 recovery requires inactive G1 state' >&2; exit 65; }
[[ "$(git -C "$source_directory" rev-parse HEAD)" == "$accepted_g0_source_commit" && -z "$(git -C "$source_directory" status --porcelain)" ]] || {
  printf '%s\n' 'G0 recovery requires the exact clean accepted ff5 checkout' >&2; exit 65;
}

live_container_id="$(compose_base ps -q openbot)"
readonly live_container_id
[[ "$live_container_id" == "$expected_live_container_id" ]] || exit 65
live_config_id="$(docker inspect --format '{{.Image}}' "$live_container_id")"
readonly live_config_id
[[ "$live_config_id" == "$expected_live_config_id" ]] || exit 65
[[ "$(container_health "$live_container_id")" == healthy ]] || exit 65

g0_image_reference="$(compose_base config --format json | jq -er '.services.openbot.image')"
readonly g0_image_reference
previous_base_index_id="$(docker image inspect --format '{{.Id}}' "$g0_image_reference")"
readonly previous_base_index_id
previous_base_descriptor_digest="$(docker image inspect --format '{{index .Descriptor "digest"}}' "$g0_image_reference")"
readonly previous_base_descriptor_digest
[[ "$previous_base_index_id" =~ ^sha256:[a-f0-9]{64}$ && "$previous_base_descriptor_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 65
readonly previous_base_exact_reference="${g0_image_reference}@${previous_base_descriptor_digest}"

nonce="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${nonce}-$$"
temporary_directory="$(mktemp -d "${incoming_directory}/g0-recovery.${run_id}.XXXXXX")"
recovery_reference="local/openbot:g0-recovery-${accepted_g0_source_commit}-${nonce}"
recovery_build_overlay="${temporary_directory}/recovery.image.yml"
base_render="${temporary_directory}/base.json"
g0_render="${temporary_directory}/g0.json"
recovery_build_render="${temporary_directory}/recovery-build.json"
evidence_file="${incoming_directory}/g0-recovery-${run_id}.evidence"
probe_container_name="openbot-g0-recovery-probe-${run_id}"
base_retagged=0
apply_started=0
success=0
probe_active=0

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  cleanup_failed=0
  if [[ "$probe_active" -eq 1 ]]; then
    docker rm -f "$probe_container_name" >/dev/null 2>&1 || cleanup_failed=1
    probe_active=0
  fi
  if [[ "$success" -ne 1 && "$base_retagged" -eq 1 && "$apply_started" -eq 0 ]]; then
    docker image tag "$previous_base_exact_reference" "$g0_image_reference" >/dev/null || exit 70
    [[ "$(docker image inspect --format '{{.Id}}' "$g0_image_reference" 2>/dev/null)" == "$previous_base_index_id" ]] || exit 70
    [[ "$(docker image inspect --format '{{index .Descriptor "digest"}}' "$g0_image_reference" 2>/dev/null)" == "$previous_base_descriptor_digest" ]] || exit 70
  fi
  rm -rf "$temporary_directory" || cleanup_failed=1
  if [[ "$success" -ne 1 && "$base_retagged" -eq 0 ]]; then docker image rm "$recovery_reference" >/dev/null 2>&1 || true; fi
  [[ "$cleanup_failed" -eq 0 ]] || exit 71
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

compose_base config --format json >"$base_render"
compose_base -f "$g0_overlay_file" config --format json >"$g0_render"
"${source_directory}/deploy/netsfera/verify-rendered-overlay.sh" "$base_render" "$g0_render" >/dev/null
printf 'services:\n  openbot:\n    image: "%s"\n' "$recovery_reference" >"$recovery_build_overlay"
compose_base -f "$g0_overlay_file" -f "$recovery_build_overlay" config --format json >"$recovery_build_render"
jq -e --arg expected "$recovery_reference" '.services.openbot.image == $expected' "$recovery_build_render" >/dev/null
[[ "$(jq -S 'del(.services.openbot.image)' "$g0_render" | sha256sum | awk '{print $1}')" == "$(jq -S 'del(.services.openbot.image)' "$recovery_build_render" | sha256sum | awk '{print $1}')" ]] || exit 65

test_source="${temporary_directory}/test-source"
git clone --quiet --no-hardlinks "$source_directory" "$test_source"
git -C "$test_source" checkout --detach "$accepted_g0_source_commit" >/dev/null
docker run --rm -v "${test_source}:/source:rw" -w /source "$bun_test_image" sh -ceu \
  'bun install --frozen-lockfile && bun test server/tests/computer-policy.test.ts server/tests/computer-access.test.ts server/tests/computer-stream-access.test.ts server/tests/app-build-tenant-config.test.ts app/tests/computer-access.test.ts && bun run --cwd app typecheck'

"$compose_helper" --lock-held-fd 9 --reviewed-controller -p "$project_name" -f "$recovery_build_render" build openbot
recovery_index_id="$(docker image inspect --format '{{.Id}}' "$recovery_reference")"
recovery_descriptor_digest="$(docker image inspect --format '{{index .Descriptor "digest"}}' "$recovery_reference")"
[[ "$recovery_index_id" =~ ^sha256:[a-f0-9]{64}$ && "$recovery_descriptor_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 65
recovery_exact_reference="${recovery_reference}@${recovery_descriptor_digest}"
[[ "$(docker image inspect --format '{{.Id}}' "$recovery_exact_reference")" == "$recovery_index_id" ]] || exit 65
probe_active=1
probe_container_id="$(docker create --name "$probe_container_name" --entrypoint /bin/true "$recovery_exact_reference")"
[[ "$probe_container_id" =~ ^[a-f0-9]{64}$ ]] || exit 65
recovery_image_id="$(docker inspect --format '{{.Image}}' "$probe_container_id")"
[[ "$recovery_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 65
docker rm -f "$probe_container_id" >/dev/null
probe_active=0
docker run --rm --entrypoint sh "$recovery_exact_reference" -ceu 'grep -R -F -q "NETSFERA ERP" /app/app/dist 2>/dev/null'
[[ "$(git -C "$source_directory" rev-parse HEAD)" == "$accepted_g0_source_commit" && -z "$(git -C "$source_directory" status --porcelain)" ]] || exit 65
[[ "$(compose_base ps -q openbot)" == "$live_container_id" && "$(docker inspect --format '{{.Image}}' "$live_container_id")" == "$live_config_id" && "$(container_health "$live_container_id")" == healthy ]] || exit 70

docker image tag "$recovery_exact_reference" "$g0_image_reference"
base_retagged=1
[[ "$(docker image inspect --format '{{.Id}}' "$g0_image_reference")" == "$recovery_index_id" && "$(docker image inspect --format '{{index .Descriptor "digest"}}' "$g0_image_reference")" == "$recovery_descriptor_digest" ]] || exit 70
apply_started=1
compose_base -f "$g0_overlay_file" up --detach --no-deps --force-recreate openbot
new_live_container_id="$(compose_base -f "$g0_overlay_file" ps -q openbot)"
[[ "$new_live_container_id" =~ ^[a-f0-9]{64}$ && "$new_live_container_id" != "$live_container_id" ]] || exit 70
[[ "$(docker inspect --format '{{.Image}}' "$new_live_container_id")" == "$recovery_image_id" ]] || exit 70
wait_healthy "$new_live_container_id" || exit 70
activation_state_absent || exit 70

{
  printf 'accepted_g0_source_commit=%s\n' "$accepted_g0_source_commit"
  printf 'g0_image_reference=%s\n' "$g0_image_reference"
  printf 'previous_base_image_id=%s\n' "$previous_base_index_id"
  printf 'previous_base_index_id=%s\n' "$previous_base_index_id"
  printf 'previous_base_descriptor_digest=%s\n' "$previous_base_descriptor_digest"
  printf 'previous_live_container_id=%s\n' "$live_container_id"
  printf 'previous_live_config_id=%s\n' "$live_config_id"
  printf 'recovered_g0_image_id=%s\n' "$recovery_image_id"
  printf 'recovered_g0_index_id=%s\n' "$recovery_index_id"
  printf 'recovered_g0_descriptor_digest=%s\n' "$recovery_descriptor_digest"
  printf 'recovered_g0_exact_reference=%s\n' "$recovery_exact_reference"
  printf 'new_live_container_id=%s\n' "$new_live_container_id"
  printf 'g0_render_sha256=%s\n' "$(sha256sum "$g0_render" | awk '{print $1}')"
  printf '%s\n' 'new_live_health=healthy'
} >"$evidence_file"
chmod 0600 "$evidence_file"
success=1
printf 'G0 baseline recovery complete; private evidence: %s\n' "$evidence_file"
