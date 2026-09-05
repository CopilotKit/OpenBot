#!/bin/sh
# Commit-bound G1 staging: build and retain an exact-image candidate without
# recreating, starting or executing the live OpenBot service.
set -eu
set +x

if test "$#" -ne 4; then
  printf '%s\n' 'usage: stage-reviewed-g1.sh <bundle-path> <bundle-sha256> <advertised-ref> <target-commit>' >&2
  exit 64
fi

readonly bundle_path="$1"
readonly expected_bundle_sha256="$2"
readonly advertised_ref="$3"
readonly target_commit="$4"
readonly source_directory="${OPENBOT_SOURCE_DIR:-/opt/openbot/source}"
readonly incoming_directory="${OPENBOT_INCOMING_DIR:-/root/openbot-incoming}"
readonly project_name="${OPENBOT_COMPOSE_PROJECT:-openbot}"
readonly base_env_file="${OPENBOT_BASE_ENV_FILE:-/opt/openbot/.env}"
readonly phase2_env_file="${OPENBOT_PHASE2_ENV_FILE:-/etc/netsfera/bot-zero-trust/erp-phase2.env}"
readonly base_compose_file="${OPENBOT_BASE_COMPOSE_FILE:-/opt/openbot/docker-compose.yml}"
readonly supervisor_compose_file="${OPENBOT_SUPERVISOR_COMPOSE_FILE:-/opt/openbot/docker-compose.browser-supervisor.yml}"
readonly phase2_compose_file="${OPENBOT_PHASE2_COMPOSE_FILE:-/opt/openbot/docker-compose.erp-phase2.yml}"
readonly g1_overlay_file="${OPENBOT_G1_OVERLAY_FILE:-${source_directory}/deploy/netsfera/docker-compose.erp-agent.yml}"
readonly expected_owner="${OPENBOT_EXPECTED_BUNDLE_OWNER:-0:0}"
readonly deployment_lock_file="${OPENBOT_DEPLOYMENT_LOCK_FILE:-/var/lock/openbot-deployment.lock}"
readonly expected_lock_owner="${OPENBOT_EXPECTED_LOCK_OWNER:-0:0}"
readonly minimum_free_kb="${OPENBOT_STAGE_MIN_FREE_KB:-1048576}"
readonly bun_test_image='oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4'
readonly accepted_g0_source_commit='ff5aa7ebd8ac798887017bfa1f5a471483b0c499'
readonly activation_marker="${OPENBOT_G1_ACTIVATION_MARKER:-/etc/netsfera/bot-zero-trust/enable-openbot-g1}"
readonly activation_manifest="${OPENBOT_G1_ACTIVATION_MANIFEST:-/etc/netsfera/bot-zero-trust/openbot-g1-activation.manifest}"
readonly compose_helper="${OPENBOT_COMPOSE_HELPER:-/usr/local/lib/netsfera/openbot-compose-v1.sh}"

if test "$(printf '%s' "$target_commit" | grep -Ec '^[a-f0-9]{40}$')" -ne 1 || \
  test "$advertised_ref" != "refs/netsfera-review/${target_commit}"; then
  printf '%s\n' 'reviewed advertised ref is not canonical for the requested commit' >&2
  exit 65
fi
if test "$(printf '%s' "$minimum_free_kb" | grep -Ec '^[1-9][0-9]*$')" -ne 1; then
  printf '%s\n' 'staging free-space floor is invalid' >&2
  exit 65
fi

for required_command in awk chmod cut date df docker flock git grep jq mktemp od rm sha256sum stat tr; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$required_command" >&2
    exit 65
  fi
done
if test ! -d "$incoming_directory" || test ! -d "$source_directory/.git" || test ! -f "$bundle_path"; then
  printf '%s\n' 'reviewed bundle, incoming directory, or OpenBot source checkout is missing' >&2
  exit 65
fi
available_kb="$(df -Pk "$incoming_directory" | awk 'NR == 2 { print $4 }')"
if test "$(printf '%s' "$available_kb" | grep -Ec '^[0-9]+$')" -ne 1 || test "$available_kb" -lt "$minimum_free_kb"; then
  printf '%s\n' 'insufficient free space for reviewed G1 staging' >&2
  exit 65
fi
resolved_bun_image_id="$(docker image inspect --format '{{.Id}}' "$bun_test_image" 2>/dev/null)"
if test "$(printf '%s' "$resolved_bun_image_id" | grep -Ec '^sha256:[a-f0-9]{64}$')" -ne 1; then
  printf '%s\n' 'pinned Bun test image is not present with a valid image ID' >&2
  exit 65
fi

umask 077
lock_owner_mode() {
  if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then stat -c '%u:%g %a' "$1"; else stat -f '%u:%g %Lp' "$1"; fi
}
lock_inode() {
  if stat -Lc '%d:%i' "$1" >/dev/null 2>&1; then stat -Lc '%d:%i' "$1"; else stat -f '%d:%i' "$1"; fi
}
if test ! -e "$deployment_lock_file" && test ! -L "$deployment_lock_file"; then
  (set -C; : >"$deployment_lock_file") 2>/dev/null || true
fi
if test ! -f "$deployment_lock_file" || test -L "$deployment_lock_file" || \
  test "$(lock_owner_mode "$deployment_lock_file")" != "$expected_lock_owner 600"; then
  printf '%s\n' 'OpenBot deployment lock file is unsafe' >&2
  exit 65
fi
exec 9>"$deployment_lock_file"
if ! flock -n 9; then
  printf '%s\n' 'OpenBot deployment lock is held by a concurrent stage, promotion or restart' >&2
  exit 75
fi
if test "$(lock_inode "$deployment_lock_file")" != "$(lock_inode "/proc/$$/fd/9")"; then
  printf '%s\n' 'OpenBot deployment lock identity changed during acquisition' >&2
  exit 65
fi
activation_state_absent() {
  test ! -e "$activation_marker" && test ! -L "$activation_marker" && \
    test ! -e "$activation_manifest" && test ! -L "$activation_manifest"
}
if ! activation_state_absent; then
  printf '%s\n' 'G1 staging requires an entirely inactive activation state' >&2
  exit 65
fi

nonce="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${nonce}-$$"
readonly run_id
temporary_directory="$(mktemp -d "${incoming_directory}/g1-stage.${run_id}.XXXXXX")"
readonly temporary_directory
readonly base_render="${temporary_directory}/base.json"
readonly candidate_render="${temporary_directory}/candidate.json"
readonly candidate_build_overlay="${temporary_directory}/candidate-build.image.yml"
readonly candidate_build_render="${temporary_directory}/candidate-build.json"
readonly apply_render="${temporary_directory}/apply.json"
readonly test_source_directory="${temporary_directory}/test-source"
readonly evidence_file="${incoming_directory}/g1-stage-${target_commit}-${run_id}.evidence"
readonly candidate_overlay_file="${incoming_directory}/g1-stage-${target_commit}-${run_id}.image.yml"
rollback_ready=0
success=0
candidate_tag_may_exist=0
overlay_created=0
evidence_created=0
candidate_unique_reference=''
probe_container_name="openbot-g1-stage-probe-${run_id}"
resolved_platform_config_id=''
probe_active=0

compose_base() {
  "$compose_helper" --lock-held-fd 9 --reviewed-controller -p "$project_name" \
    --env-file "$base_env_file" \
    --env-file "$phase2_env_file" \
    -f "$base_compose_file" \
    -f "$supervisor_compose_file" \
    -f "$phase2_compose_file" \
    "$@"
}

file_owner_mode() {
  if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then
    stat -c '%u:%g %a' "$1"
  else
    stat -f '%u:%g %Lp' "$1"
  fi
}

container_health() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$1"
}

clean_up_temporary_files() {
  if test "$probe_active" -eq 1; then
    docker rm -f "$probe_container_name" >/dev/null 2>&1 || return 1
    probe_active=0
  fi
  rm -rf "$temporary_directory"
}

resolve_platform_config_id() {
  probe_reference="$1"
  docker rm -f "$probe_container_name" >/dev/null 2>&1 || true
  probe_active=1
  probe_container_id="$(docker create --name "$probe_container_name" --entrypoint /bin/true "$probe_reference")"
  if test "$(printf '%s' "$probe_container_id" | grep -Ec '^[a-f0-9]{64}$')" -ne 1; then
    printf '%s\n' 'could not create an exact stopped image probe' >&2
    return 65
  fi
  resolved_platform_config_id="$(docker inspect --format '{{.Image}}' "$probe_container_id")"
  docker rm -f "$probe_container_id" >/dev/null
  probe_active=0
  if test "$(printf '%s' "$resolved_platform_config_id" | grep -Ec '^sha256:[a-f0-9]{64}$')" -ne 1; then
    printf '%s\n' 'stopped image probe returned an invalid platform config ID' >&2
    return 65
  fi
}

restore_g0_state() {
  restore_failed=0
  set +e
  printf '%s\n' 'staging failed; restoring recorded G0 source and removing isolated candidate' >&2

  restored_reference_id="$(docker image inspect --format '{{.Id}}' "$g0_image_reference" 2>/dev/null)"
  if test "$restored_reference_id" != "$g0_index_id"; then
    printf '%s\n' 'rollback failure: configured image reference does not match G0 OCI index ID' >&2
    restore_failed=1
  fi
  restored_descriptor_digest="$(docker image inspect --format '{{index .Descriptor "digest"}}' "$g0_image_reference" 2>/dev/null)"
  if test "$restored_descriptor_digest" != "$g0_descriptor_digest"; then
    printf '%s\n' 'rollback failure: configured image descriptor does not match G0 evidence' >&2
    restore_failed=1
  fi

  if test "$candidate_tag_may_exist" -eq 1 && docker image inspect "$candidate_unique_reference" >/dev/null 2>&1; then
    if ! docker image rm "$candidate_unique_reference" >/dev/null 2>&1; then
      printf '%s\n' 'rollback failure: could not remove the staged candidate tag' >&2
      restore_failed=1
    elif docker image inspect "$candidate_unique_reference" >/dev/null 2>&1; then
      printf '%s\n' 'rollback failure: staged candidate tag is still present' >&2
      restore_failed=1
    fi
  fi
  if test "$overlay_created" -eq 1 && ! rm -f "$candidate_overlay_file"; then
    printf '%s\n' 'rollback failure: could not remove the staged image overlay' >&2
    restore_failed=1
  fi
  if test "$evidence_created" -eq 1 && ! rm -f "$evidence_file"; then
    printf '%s\n' 'rollback failure: could not remove successful staging evidence' >&2
    restore_failed=1
  fi

  if ! git -C "$source_directory" checkout --detach "$g0_source_commit" >/dev/null; then
    printf '%s\n' 'rollback failure: could not restore G0 source checkout' >&2
    restore_failed=1
  fi
  restored_head="$(git -C "$source_directory" rev-parse HEAD 2>/dev/null)"
  if test "$restored_head" != "$g0_source_commit"; then
    printf '%s\n' 'rollback failure: restored source revision differs from G0 evidence' >&2
    restore_failed=1
  fi
  if ! restored_status="$(git -C "$source_directory" status --porcelain 2>/dev/null)"; then
    printf '%s\n' 'rollback failure: could not verify restored source status' >&2
    restore_failed=1
  elif test -n "$restored_status"; then
    printf '%s\n' 'rollback failure: restored source is not clean' >&2
    restore_failed=1
  fi

  restored_config_reference="$(compose_base config --format json 2>/dev/null | jq -er '.services.openbot.image' 2>/dev/null)"
  if test "$restored_config_reference" != "$g0_image_reference"; then
    printf '%s\n' 'rollback failure: restored Compose image reference differs from G0 evidence' >&2
    restore_failed=1
  fi
  restored_container="$(compose_base ps -q openbot 2>/dev/null)"
  if test "$restored_container" != "$g0_container_id"; then
    printf '%s\n' 'rollback failure: live container identity changed during staging' >&2
    restore_failed=1
  fi
  restored_live_image="$(docker inspect --format '{{.Image}}' "$restored_container" 2>/dev/null)"
  if test "$restored_live_image" != "$g0_image_id"; then
    printf '%s\n' 'rollback failure: live container image changed during staging' >&2
    restore_failed=1
  fi
  restored_health="$(container_health "$restored_container" 2>/dev/null)"
  if test "$restored_health" != healthy; then
    printf '%s\n' 'rollback failure: unchanged live container is not healthy' >&2
    restore_failed=1
  fi
  if ! activation_state_absent; then
    printf '%s\n' 'rollback failure: G1 activation state is not inactive' >&2
    restore_failed=1
  fi
  set -e

  if test "$restore_failed" -ne 0; then
    printf '%s\n' 'CRITICAL: automatic G1 staging rollback is incomplete' >&2
    return 70
  fi
  return 0
}

on_exit() {
  status=$?
  rollback_status=0
  cleanup_status=0
  trap - EXIT HUP INT TERM
  set +e

  if test "$success" -eq 1; then
    if ! clean_up_temporary_files; then
      cleanup_status=71
      success=0
      restore_g0_state || rollback_status=$?
      clean_up_temporary_files >/dev/null 2>&1 || true
    fi
  else
    if test "$rollback_ready" -eq 1; then
      restore_g0_state || rollback_status=$?
    fi
    clean_up_temporary_files || cleanup_status=71
  fi

  if test "$rollback_status" -ne 0; then
    printf '%s\n' 'CRITICAL: staging rollback is incomplete; cleanup cannot change that result' >&2
    exit 70
  fi
  if test "$cleanup_status" -ne 0; then
    printf '%s\n' 'staging cleanup failed after G0 restoration; private files require manual removal' >&2
    exit 71
  fi
  if test "$success" -eq 1; then
    printf 'G1 staging complete; private evidence: %s\n' "$evidence_file"
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

if test "$(printf '%s' "$expected_bundle_sha256" | grep -Ec '^[a-f0-9]{64}$')" -ne 1; then
  printf '%s\n' 'reviewed bundle SHA-256 has invalid format' >&2
  exit 65
fi
if test "$(sha256sum "$bundle_path" | awk '{ print $1 }')" != "$expected_bundle_sha256"; then
  printf '%s\n' 'reviewed bundle SHA-256 mismatch' >&2
  exit 65
fi
if test "$(file_owner_mode "$bundle_path")" != "${expected_owner} 600"; then
  printf '%s\n' 'reviewed bundle owner or mode is not approved' >&2
  exit 65
fi
git -C "$source_directory" bundle verify "$bundle_path" >/dev/null
advertised_commit="$(git -C "$source_directory" bundle list-heads "$bundle_path" | awk -v ref="$advertised_ref" '$2 == ref { print $1 }')"
if test "$advertised_commit" != "$target_commit"; then
  printf '%s\n' 'reviewed bundle does not advertise the requested commit' >&2
  exit 65
fi

g0_source_commit="$(git -C "$source_directory" rev-parse HEAD)"
if test -n "$(git -C "$source_directory" status --porcelain)"; then
  printf '%s\n' 'existing G0 source checkout is not clean' >&2
  exit 65
fi
if test "$g0_source_commit" != "$accepted_g0_source_commit"; then
  printf '%s\n' 'existing source is not the accepted G0 source commit' >&2
  exit 65
fi
g0_image_reference="$(compose_base config --format json | jq -er '.services.openbot.image')"
g0_container_id="$(compose_base ps -q openbot)"
if test "$(printf '%s' "$g0_container_id" | grep -Ec '^[0-9a-f]{64}$')" -ne 1; then
  printf '%s\n' 'existing live OpenBot container cannot be resolved exactly' >&2
  exit 65
fi
g0_image_id="$(docker inspect --format '{{.Image}}' "$g0_container_id")"
if test "$(printf '%s' "$g0_image_id" | grep -Ec '^sha256:[0-9a-f]{64}$')" -ne 1; then
  printf '%s\n' 'existing live OpenBot image ID is invalid' >&2
  exit 65
fi
g0_index_id="$(docker image inspect --format '{{.Id}}' "$g0_image_reference")"
if test "$(printf '%s' "$g0_index_id" | grep -Ec '^sha256:[0-9a-f]{64}$')" -ne 1; then exit 65; fi
g0_descriptor_digest="$(docker image inspect --format '{{index .Descriptor "digest"}}' "$g0_image_reference")"
if test "$(printf '%s' "$g0_descriptor_digest" | grep -Ec '^sha256:[0-9a-f]{64}$')" -ne 1; then
  printf '%s\n' 'configured G0 image descriptor digest is invalid' >&2
  exit 65
fi
g0_exact_reference="${g0_image_reference}@${g0_descriptor_digest}"
resolve_platform_config_id "$g0_exact_reference"
if test "$resolved_platform_config_id" != "$g0_image_id"; then
  printf '%s\n' 'configured base OCI descriptor does not resolve to the live G0 platform config' >&2
  exit 65
fi
if test "$(container_health "$g0_container_id")" != healthy; then
  printf '%s\n' 'existing live OpenBot container is not healthy' >&2
  exit 65
fi
if ! prohibited_grants="$(compose_base exec -T postgres psql -v ON_ERROR_STOP=1 -U openbot -d openbot -At -c "SELECT agent_id, kind, ref FROM plugin_grants WHERE agent_id IN ('jefe-erp', 'recolector-documentos') AND kind <> 'skill' ORDER BY agent_id, kind, ref")" || test -n "$prohibited_grants"; then
  printf '%s\n' 'document staging requires no MCP, bot or other capability grants' >&2
  exit 65
fi
if test -e "$evidence_file" || test -e "$candidate_overlay_file"; then
  printf '%s\n' 'staging run identifier collides with existing evidence or overlay' >&2
  exit 65
fi
rollback_ready=1

git -C "$source_directory" fetch --no-tags "$bundle_path" "${advertised_ref}:refs/heads/g1-reviewed-artifact"
test "$(git -C "$source_directory" rev-parse refs/heads/g1-reviewed-artifact)" = "$target_commit"
git -C "$source_directory" cat-file -e "${target_commit}^{commit}"
git -C "$source_directory" checkout --detach "$target_commit" >/dev/null
test "$(git -C "$source_directory" rev-parse HEAD)" = "$target_commit"
if test -n "$(git -C "$source_directory" status --porcelain)"; then
  printf '%s\n' 'reviewed G1 checkout is not clean' >&2
  exit 65
fi

"${source_directory}/deploy/netsfera/verify-reviewed-action-policy.sh" --lock-held-fd 9 \
  "${source_directory}/deploy/netsfera/agent-computer-policy.json"

git clone --quiet --no-hardlinks "$source_directory" "$test_source_directory"
git -C "$test_source_directory" checkout --detach "$target_commit" >/dev/null
docker run --rm -v "${test_source_directory}:/source:rw" -w /source "$bun_test_image" sh -ceu '
  bun install --frozen-lockfile
  bun test \
    server/tests/computer-policy.test.ts \
    server/tests/computer-access.test.ts \
    server/tests/computer-stream-access.test.ts \
    server/tests/app-build-tenant-config.test.ts \
    server/tests/netsfera-document-agents.test.ts \
    server/tests/netsfera-document-package-probe.test.ts \
    app/tests/computer-access.test.ts
  bun run typecheck
'

compose_base config --format json >"$base_render"
compose_base -f "$g1_overlay_file" config --format json >"$candidate_render"
chmod 0600 "$base_render" "$candidate_render"
"${source_directory}/deploy/netsfera/verify-rendered-overlay.sh" "$base_render" "$candidate_render" >/dev/null

candidate_base_reference="$(jq -er '.services.openbot.image' "$candidate_render")"
if test "$candidate_base_reference" != "$g0_image_reference"; then
  printf '%s\n' 'candidate build reference differs from the captured base reference' >&2
  exit 65
fi
candidate_unique_reference="local/openbot:g1-${target_commit}-${nonce}"
if docker image inspect "$candidate_unique_reference" >/dev/null 2>&1; then
  printf '%s\n' 'candidate image reference collides with an existing tag' >&2
  exit 65
fi
if ! (set -C; printf 'services:\n  openbot:\n    image: "%s"\n' "$candidate_unique_reference" >"$candidate_build_overlay") 2>/dev/null; then
  printf '%s\n' 'could not create isolated candidate build overlay' >&2
  exit 65
fi
chmod 0600 "$candidate_build_overlay"
compose_base -f "$g1_overlay_file" -f "$candidate_build_overlay" config --format json >"$candidate_build_render"
chmod 0600 "$candidate_build_render"
if ! jq -e --arg expected_image "$candidate_unique_reference" '.services.openbot.image == $expected_image' "$candidate_build_render" >/dev/null; then
  printf '%s\n' 'isolated candidate build overlay did not select its unique reference' >&2
  exit 65
fi
candidate_topology_hash="$(jq -S 'del(.services.openbot.image)' "$candidate_render" | sha256sum | awk '{ print $1 }')"
build_topology_hash="$(jq -S 'del(.services.openbot.image)' "$candidate_build_render" | sha256sum | awk '{ print $1 }')"
if test "$candidate_topology_hash" != "$build_topology_hash"; then
  printf '%s\n' 'isolated build overlay changed more than the OpenBot image' >&2
  exit 65
fi
candidate_tag_may_exist=1
"$compose_helper" --lock-held-fd 9 --reviewed-controller -p "$project_name" -f "$candidate_build_render" build openbot
candidate_index_id="$(docker image inspect --format '{{.Id}}' "$candidate_unique_reference")"
if test "$(printf '%s' "$candidate_index_id" | grep -Ec '^sha256:[0-9a-f]{64}$')" -ne 1; then
  printf '%s\n' 'candidate OCI index ID is invalid' >&2
  exit 65
fi
candidate_descriptor_digest="$(docker image inspect --format '{{index .Descriptor "digest"}}' "$candidate_unique_reference")"
if test "$(printf '%s' "$candidate_descriptor_digest" | grep -Ec '^sha256:[0-9a-f]{64}$')" -ne 1; then
  printf '%s\n' 'candidate image descriptor digest is invalid' >&2
  exit 65
fi
candidate_exact_reference="${candidate_unique_reference}@${candidate_descriptor_digest}"
if test "$(docker image inspect --format '{{.Id}}' "$candidate_exact_reference")" != "$candidate_index_id" || \
  test "$(docker image inspect --format '{{index .Descriptor "digest"}}' "$candidate_exact_reference")" != "$candidate_descriptor_digest"; then
  printf '%s\n' 'candidate exact OCI reference does not resolve to the built image' >&2
  exit 65
fi
resolve_platform_config_id "$candidate_exact_reference"
candidate_image_id="$resolved_platform_config_id"
"${source_directory}/deploy/netsfera/verify-netsfera-document-image.sh" "$candidate_exact_reference" "$temporary_directory"
docker run --rm --entrypoint sh "$candidate_exact_reference" -ceu 'grep -R -F -q "NETSFERA ERP" /app/app/dist 2>/dev/null'

if ! (set -C; printf 'services:\n  openbot:\n    image: "%s"\n' "$candidate_exact_reference" >"$candidate_overlay_file") 2>/dev/null; then
  printf '%s\n' 'refusing to overwrite an existing exact-image overlay' >&2
  exit 65
fi
overlay_created=1
chmod 0600 "$candidate_overlay_file"
candidate_overlay_hash="$(sha256sum "$candidate_overlay_file" | awk '{ print $1 }')"

compose_base -f "$g1_overlay_file" -f "$candidate_overlay_file" config --format json >"$apply_render"
chmod 0600 "$apply_render"
if ! jq -e --arg expected_image "$candidate_exact_reference" '.services.openbot.image == $expected_image' "$apply_render" >/dev/null; then
  printf '%s\n' 'exact-image overlay did not render the candidate image ID' >&2
  exit 65
fi
apply_topology_hash="$(jq -S 'del(.services.openbot.image)' "$apply_render" | sha256sum | awk '{ print $1 }')"
if test "$candidate_topology_hash" != "$apply_topology_hash"; then
  printf '%s\n' 'exact-image overlay changed more than the OpenBot image' >&2
  exit 65
fi
candidate_apply_render_hash="$(sha256sum "$apply_render" | awk '{ print $1 }')"

test "$(git -C "$source_directory" rev-parse HEAD)" = "$target_commit"
if test -n "$(git -C "$source_directory" status --porcelain)"; then
  printf '%s\n' 'reviewed G1 checkout is not clean after build' >&2
  exit 65
fi

if test "$(docker image inspect --format '{{.Id}}' "$g0_image_reference")" != "$g0_index_id"; then
  printf '%s\n' 'configured base image reference changed during isolated staging' >&2
  exit 65
fi
if test "$(docker image inspect --format '{{index .Descriptor "digest"}}' "$g0_image_reference")" != "$g0_descriptor_digest"; then
  printf '%s\n' 'configured base image descriptor changed during isolated staging' >&2
  exit 65
fi
if test "$(docker image inspect --format '{{.Id}}' "$candidate_unique_reference")" != "$candidate_index_id"; then
  printf '%s\n' 'unique candidate image tag changed during base reference restoration' >&2
  exit 65
fi
if test "$(compose_base config --format json | jq -er '.services.openbot.image')" != "$g0_image_reference"; then
  printf '%s\n' 'base Compose render changed during staging' >&2
  exit 65
fi

test "$(compose_base ps -q openbot)" = "$g0_container_id"
test "$(docker inspect --format '{{.Image}}' "$g0_container_id")" = "$g0_image_id"
test "$(container_health "$g0_container_id")" = healthy
if ! activation_state_absent; then
  printf '%s\n' 'G1 activation state appeared during staging' >&2
  exit 65
fi
functional_overlay_hash="$(sha256sum "$g1_overlay_file" | awk '{ print $1 }')"
if test "$(git -C "$source_directory" show "${target_commit}:deploy/netsfera/docker-compose.erp-agent.yml" | sha256sum | awk '{ print $1 }')" != "$functional_overlay_hash"; then
  printf '%s\n' 'functional overlay differs from the reviewed commit blob' >&2
  exit 65
fi

"${source_directory}/deploy/netsfera/verify-reviewed-action-policy.sh" --lock-held-fd 9 \
  "${source_directory}/deploy/netsfera/agent-computer-policy.json"

if ! (set -C; {
  printf 'g0_source_commit=%s\n' "$g0_source_commit"
  printf 'accepted_g0_source_commit=%s\n' "$accepted_g0_source_commit"
  printf 'g0_image_reference=%s\n' "$g0_image_reference"
  printf 'g0_image_id=%s\n' "$g0_image_id"
  printf 'g0_index_id=%s\n' "$g0_index_id"
  printf 'g0_descriptor_digest=%s\n' "$g0_descriptor_digest"
  printf 'g0_container_id=%s\n' "$g0_container_id"
  printf 'candidate_commit=%s\n' "$target_commit"
  printf 'candidate_image_reference=%s\n' "$candidate_unique_reference"
  printf 'candidate_image_id=%s\n' "$candidate_image_id"
  printf 'candidate_index_id=%s\n' "$candidate_index_id"
  printf 'candidate_descriptor_digest=%s\n' "$candidate_descriptor_digest"
  printf 'candidate_exact_reference=%s\n' "$candidate_exact_reference"
  printf 'candidate_overlay_path=%s\n' "$candidate_overlay_file"
  printf 'candidate_overlay_sha256=%s\n' "$candidate_overlay_hash"
  printf 'functional_overlay_path=%s\n' "$g1_overlay_file"
  printf 'functional_overlay_sha256=%s\n' "$functional_overlay_hash"
  printf 'candidate_apply_render_sha256=%s\n' "$candidate_apply_render_hash"
  printf 'bun_test_image=%s\n' "$bun_test_image"
  printf '%s\n' 'live_container_health=healthy'
  printf '%s\n' 'stored_action_policy=absent-or-reviewed-equivalent'
} >"$evidence_file") 2>/dev/null; then
  printf '%s\n' 'refusing to overwrite existing staging evidence' >&2
  exit 65
fi
evidence_created=1
chmod 0600 "$evidence_file"
success=1
