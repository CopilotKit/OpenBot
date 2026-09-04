#!/bin/sh
# Verify that a staged G1 candidate still matches its private, commit-bound
# evidence before one-offs, immediately before apply, and after apply.
set -eu
set +x

readonly source_directory="${OPENBOT_SOURCE_DIR:-/opt/openbot/source}"
readonly incoming_directory="${OPENBOT_INCOMING_DIR:-/root/openbot-incoming}"
readonly project_name="${OPENBOT_COMPOSE_PROJECT:-openbot}"
readonly base_env_file="${OPENBOT_BASE_ENV_FILE:-/opt/openbot/.env}"
readonly phase2_env_file="${OPENBOT_PHASE2_ENV_FILE:-/etc/netsfera/bot-zero-trust/erp-phase2.env}"
readonly base_compose_file="${OPENBOT_BASE_COMPOSE_FILE:-/opt/openbot/docker-compose.yml}"
readonly supervisor_compose_file="${OPENBOT_SUPERVISOR_COMPOSE_FILE:-/opt/openbot/docker-compose.browser-supervisor.yml}"
readonly phase2_compose_file="${OPENBOT_PHASE2_COMPOSE_FILE:-/opt/openbot/docker-compose.erp-phase2.yml}"
readonly g1_overlay_file="${OPENBOT_G1_OVERLAY_FILE:-${source_directory}/deploy/netsfera/docker-compose.erp-agent.yml}"
readonly expected_owner="${OPENBOT_EXPECTED_EVIDENCE_OWNER:-0:0}"
readonly verifier_repo_path=deploy/netsfera/verify-staged-g1.sh
readonly expected_bun_image='oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4'
readonly accepted_g0_source_commit='ff5aa7ebd8ac798887017bfa1f5a471483b0c499'
readonly deployment_lock_file="${OPENBOT_DEPLOYMENT_LOCK_FILE:-/var/lock/openbot-deployment.lock}"
readonly expected_lock_owner="${OPENBOT_EXPECTED_LOCK_OWNER:-0:0}"
readonly activation_marker="${OPENBOT_G1_ACTIVATION_MARKER:-/etc/netsfera/bot-zero-trust/enable-openbot-g1}"
readonly activation_manifest="${OPENBOT_G1_ACTIVATION_MANIFEST:-/etc/netsfera/bot-zero-trust/openbot-g1-activation.manifest}"
readonly compose_helper="${OPENBOT_COMPOSE_HELPER:-/usr/local/lib/netsfera/openbot-compose-v1.sh}"

umask 077

inode_of() {
  if stat -Lc '%d:%i' "$1" >/dev/null 2>&1; then
    stat -Lc '%d:%i' "$1"
  else
    stat -f '%d:%i' "$1"
  fi
}

lock_owner_mode() {
  if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then stat -c '%u:%g %a' "$1"; else stat -f '%u:%g %Lp' "$1"; fi
}

if test ! -e "$deployment_lock_file" && test ! -L "$deployment_lock_file"; then
  (set -C; : >"$deployment_lock_file") 2>/dev/null || true
fi
if test ! -f "$deployment_lock_file" || test -L "$deployment_lock_file" || \
  test "$(lock_owner_mode "$deployment_lock_file")" != "$expected_lock_owner 600"; then
  printf '%s\n' 'OpenBot deployment lock file is unsafe' >&2
  exit 65
fi

if test "${1:-}" = --lock-held-fd; then
  case "${2:-}" in '' | *[!0-9]*) printf '%s\n' 'invalid inherited deployment lock FD' >&2; exit 65 ;; esac
  inherited_fd="$2"
  shift 2
  if test ! -e "/proc/$$/fd/${inherited_fd}" || \
    test "$(inode_of "/proc/$$/fd/${inherited_fd}")" != "$(inode_of "$deployment_lock_file")"; then
    printf '%s\n' 'inherited deployment lock FD does not name the shared lock' >&2
    exit 65
  fi
  if ! flock -n "$inherited_fd"; then
    printf '%s\n' 'inherited deployment lock FD is not held by this controller' >&2
    exit 75
  fi
else
  exec 9>"$deployment_lock_file"
  if ! flock -n 9; then
    printf '%s\n' 'OpenBot deployment lock is held by a concurrent operation' >&2
    exit 75
  fi
fi
if test "$(inode_of "$deployment_lock_file")" != "$(inode_of "/proc/$$/fd/${inherited_fd:-9}")"; then
  printf '%s\n' 'OpenBot deployment lock identity changed during acquisition' >&2
  exit 65
fi

if test "$#" -ne 2; then
  printf '%s\n' 'usage: verify-staged-g1.sh [--lock-held-fd <fd>] <pre-oneoff|pre-apply|post-apply> <evidence-path>' >&2
  exit 64
fi
readonly phase="$1"
readonly evidence_file="$2"

case "$phase" in
  pre-oneoff | pre-apply | post-apply) ;;
  *)
    printf '%s\n' 'unknown staged G1 verification phase' >&2
    exit 64
    ;;
esac

for required_command in awk cat chmod docker flock git grep jq mktemp rm sha256sum stat; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$required_command" >&2
    exit 65
  fi
done

file_owner_mode() {
  if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then
    stat -c '%u:%g %a' "$1"
  else
    stat -f '%u:%g %Lp' "$1"
  fi
}

evidence_value() {
  awk -v key="$1" '
    index($0, key "=") == 1 {
      count += 1
      value = substr($0, length(key) + 2)
    }
    END {
      if (count != 1 || value == "") exit 1
      print value
    }
  ' "$evidence_file"
}

compose_base() {
  "$compose_helper" --lock-held-fd "${inherited_fd:-9}" --reviewed-controller -p "$project_name" \
    --env-file "$base_env_file" \
    --env-file "$phase2_env_file" \
    -f "$base_compose_file" \
    -f "$supervisor_compose_file" \
    -f "$phase2_compose_file" \
    "$@"
}

container_health() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$1"
}

case "$evidence_file" in
  "${incoming_directory}"/g1-stage-*.evidence) ;;
  *)
    printf '%s\n' 'staged G1 evidence path is outside the private incoming directory' >&2
    exit 65
    ;;
esac
if test ! -f "$evidence_file" || test "$(file_owner_mode "$evidence_file")" != "${expected_owner} 600"; then
  printf '%s\n' 'staged G1 evidence is missing or has unsafe ownership/mode' >&2
  exit 65
fi

g0_source_commit="$(evidence_value g0_source_commit)"
evidenced_accepted_g0_source_commit="$(evidence_value accepted_g0_source_commit)"
g0_image_reference="$(evidence_value g0_image_reference)"
g0_image_id="$(evidence_value g0_image_id)"
g0_index_id="$(evidence_value g0_index_id)"
g0_descriptor_digest="$(evidence_value g0_descriptor_digest)"
g0_container_id="$(evidence_value g0_container_id)"
candidate_commit="$(evidence_value candidate_commit)"
candidate_image_reference="$(evidence_value candidate_image_reference)"
candidate_image_id="$(evidence_value candidate_image_id)"
candidate_index_id="$(evidence_value candidate_index_id)"
candidate_descriptor_digest="$(evidence_value candidate_descriptor_digest)"
candidate_exact_reference="$(evidence_value candidate_exact_reference)"
candidate_overlay_path="$(evidence_value candidate_overlay_path)"
candidate_overlay_sha256="$(evidence_value candidate_overlay_sha256)"
functional_overlay_path="$(evidence_value functional_overlay_path)"
functional_overlay_sha256="$(evidence_value functional_overlay_sha256)"
candidate_apply_render_sha256="$(evidence_value candidate_apply_render_sha256)"
bun_test_image="$(evidence_value bun_test_image)"

if test "$g0_source_commit" != "$accepted_g0_source_commit" || \
  test "$evidenced_accepted_g0_source_commit" != "$accepted_g0_source_commit"; then
  printf '%s\n' 'staged G1 evidence does not originate from the accepted G0 source commit' >&2
  exit 65
fi

for commit in "$g0_source_commit" "$candidate_commit"; do
  test "$(printf '%s' "$commit" | grep -Ec '^[a-f0-9]{40}$')" -eq 1 || {
    printf '%s\n' 'staged G1 evidence contains an invalid commit' >&2
    exit 65
  }
done
for image_id in "$g0_image_id" "$g0_index_id" "$g0_descriptor_digest" "$candidate_image_id" "$candidate_index_id" "$candidate_descriptor_digest"; do
  test "$(printf '%s' "$image_id" | grep -Ec '^sha256:[a-f0-9]{64}$')" -eq 1 || {
    printf '%s\n' 'staged G1 evidence contains an invalid image ID' >&2
    exit 65
  }
done
for digest in "$candidate_overlay_sha256" "$functional_overlay_sha256" "$candidate_apply_render_sha256"; do
  test "$(printf '%s' "$digest" | grep -Ec '^[a-f0-9]{64}$')" -eq 1 || {
    printf '%s\n' 'staged G1 evidence contains an invalid digest' >&2
    exit 65
  }
done
if test "$functional_overlay_path" != "$g1_overlay_file" || \
  test ! -f "$functional_overlay_path" || test -L "$functional_overlay_path" || \
  test "$(sha256sum "$functional_overlay_path" | awk '{ print $1 }')" != "$functional_overlay_sha256"; then
  printf '%s\n' 'staged G1 functional overlay is not evidence-bound' >&2
  exit 65
fi
test "$(printf '%s' "$g0_container_id" | grep -Ec '^[a-f0-9]{64}$')" -eq 1 || {
  printf '%s\n' 'staged G1 evidence contains an invalid G0 container ID' >&2
  exit 65
}
test "$(printf '%s' "$candidate_image_reference" | grep -Ec "^local/openbot:g1-${candidate_commit}-[a-f0-9]{16}$")" -eq 1 || {
  printf '%s\n' 'staged G1 candidate reference is not canonical for its commit and image' >&2
  exit 65
}
test "$candidate_exact_reference" = "${candidate_image_reference}@${candidate_descriptor_digest}" || exit 65
test "$bun_test_image" = "$expected_bun_image" || {
  printf '%s\n' 'staged G1 evidence does not name the pinned Bun image' >&2
  exit 65
}
case "$candidate_overlay_path" in
  "${incoming_directory}"/g1-stage-"${candidate_commit}"-*.image.yml) ;;
  *)
    printf '%s\n' 'staged G1 overlay path is not canonical' >&2
    exit 65
    ;;
esac

expected_blob="$(git -C "$source_directory" rev-parse "${candidate_commit}:${verifier_repo_path}")"
expected_verifier_sha256="$(git -C "$source_directory" cat-file blob "$expected_blob" | sha256sum | awk '{ print $1 }')"
actual_verifier_sha256="$(sha256sum "$0" | awk '{ print $1 }')"
if test "$actual_verifier_sha256" != "$expected_verifier_sha256"; then
  printf '%s\n' 'staged G1 verifier bytes do not match the evidenced commit' >&2
  exit 65
fi
if test "$(git -C "$source_directory" rev-parse HEAD)" != "$candidate_commit" || \
  test -n "$(git -C "$source_directory" status --porcelain)"; then
  printf '%s\n' 'staged G1 source checkout drifted from the evidenced clean commit' >&2
  exit 65
fi
if test "$(git -C "$source_directory" show "${candidate_commit}:deploy/netsfera/docker-compose.erp-agent.yml" | sha256sum | awk '{ print $1 }')" != "$functional_overlay_sha256"; then
  printf '%s\n' 'functional overlay differs from the reviewed commit blob' >&2
  exit 65
fi
"${source_directory}/deploy/netsfera/verify-netsfera-document-image.sh" "$candidate_exact_reference" "$incoming_directory"
if test "$(compose_base config --format json | jq -er '.services.openbot.image')" != "$g0_image_reference" || \
  test "$(docker image inspect --format '{{.Id}}' "$g0_image_reference")" != "$g0_index_id" || \
  test "$(docker image inspect --format '{{index .Descriptor "digest"}}' "$g0_image_reference")" != "$g0_descriptor_digest"; then
  printf '%s\n' 'configured base image reference no longer resolves to evidenced G0' >&2
  exit 65
fi
if test "$(docker image inspect --format '{{.Id}}' "$candidate_image_reference")" != "$candidate_index_id" || \
  test "$(docker image inspect --format '{{index .Descriptor "digest"}}' "$candidate_image_reference")" != "$candidate_descriptor_digest" || \
  test "$(docker image inspect --format '{{.Id}}' "$candidate_exact_reference")" != "$candidate_index_id"; then
  printf '%s\n' 'unique staged candidate tag no longer resolves to the exact image ID' >&2
  exit 65
fi

if test ! -f "$candidate_overlay_path" || \
  test "$(file_owner_mode "$candidate_overlay_path")" != "${expected_owner} 600" || \
  test "$(sha256sum "$candidate_overlay_path" | awk '{ print $1 }')" != "$candidate_overlay_sha256"; then
  printf '%s\n' 'staged G1 exact-image overlay is missing, unsafe or changed' >&2
  exit 65
fi
expected_overlay="$(printf 'services:\n  openbot:\n    image: "%s"\n' "$candidate_exact_reference")"
if test "$(cat "$candidate_overlay_path")" != "$expected_overlay"; then
  printf '%s\n' 'staged G1 exact-image overlay content is not canonical' >&2
  exit 65
fi

umask 077
render_file=''
render_child=''
cleanup_render() {
  private_render="$render_file"
  render_file=''
  test -z "$private_render" || rm -f "$private_render"
}
on_render_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if test -n "$render_child"; then
    kill -TERM "$render_child" 2>/dev/null || true
    wait "$render_child" 2>/dev/null || true
  fi
  if ! cleanup_render; then
    printf '%s\n' 'staged verifier render cleanup failed' >&2
    exit 71
  fi
  exit "$status"
}
trap on_render_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
render_file="$(mktemp "${incoming_directory}/g1-verify.XXXXXX.json")"
# Start the helper directly so cancellation owns the exact render process PID.
"$compose_helper" --lock-held-fd "${inherited_fd:-9}" --reviewed-controller -p "$project_name" \
  --env-file "$base_env_file" --env-file "$phase2_env_file" \
  -f "$base_compose_file" -f "$supervisor_compose_file" -f "$phase2_compose_file" \
  -f "$g1_overlay_file" -f "$candidate_overlay_path" config --format json >"$render_file" &
render_child=$!
wait "$render_child"
render_child=''
chmod 0600 "$render_file"
if ! jq -e --arg expected_image "$candidate_exact_reference" '.services.openbot.image == $expected_image' "$render_file" >/dev/null || \
  test "$(sha256sum "$render_file" | awk '{ print $1 }')" != "$candidate_apply_render_sha256"; then
  printf '%s\n' 'staged G1 full apply render drifted from evidence' >&2
  exit 65
fi

if test "$phase" = post-apply; then
  if test -e "$activation_marker" || test -L "$activation_marker" || \
    test ! -f "$activation_manifest" || test -L "$activation_manifest" || \
    test "$(file_owner_mode "$activation_manifest")" != "${expected_owner} 600"; then
    printf '%s\n' 'post-apply persistent activation binding is missing or unsafe' >&2
    exit 65
  fi
  expected_activation_manifest="$(
    printf 'candidate_commit=%s\n' "$candidate_commit"
    printf 'candidate_image_reference=%s\n' "$candidate_image_reference"
    printf 'candidate_index_id=%s\n' "$candidate_index_id"
    printf 'candidate_descriptor_digest=%s\n' "$candidate_descriptor_digest"
    printf 'candidate_exact_reference=%s\n' "$candidate_exact_reference"
    printf 'candidate_image_id=%s\n' "$candidate_image_id"
    printf 'functional_overlay_path=%s\n' "$g1_overlay_file"
    printf 'functional_overlay_sha256=%s\n' "$functional_overlay_sha256"
    printf 'exact_overlay_path=%s\n' "$candidate_overlay_path"
    printf 'exact_overlay_sha256=%s\n' "$candidate_overlay_sha256"
    printf 'apply_render_sha256=%s\n' "$candidate_apply_render_sha256"
  )"
  if test "$(cat "$activation_manifest")" != "$expected_activation_manifest"; then
    printf '%s\n' 'post-apply persistent activation binding does not match staged evidence' >&2
    exit 65
  fi
  if ! prohibited_grants="$("$compose_helper" --lock-held-fd "${inherited_fd:-9}" exec -T postgres psql -v ON_ERROR_STOP=1 -U openbot -d openbot -At -c "SELECT agent_id, kind, ref FROM plugin_grants WHERE agent_id IN ('jefe-erp', 'recolector-documentos') AND kind NOT IN ('skill', 'bot') ORDER BY agent_id, kind, ref")" || test -n "$prohibited_grants"; then
    printf '%s\n' 'post-apply document agents have an unreviewed capability grant' >&2
    exit 65
  fi
  running_container_id="$(compose_base -f "$g1_overlay_file" -f "$candidate_overlay_path" ps -q openbot)"
  if test "$(printf '%s' "$running_container_id" | grep -Ec '^[a-f0-9]{64}$')" -ne 1 || \
    test "$(docker inspect --format '{{.Image}}' "$running_container_id")" != "$candidate_image_id" || \
    test "$(container_health "$running_container_id")" != healthy; then
    printf '%s\n' 'post-apply OpenBot is not the exact healthy staged image' >&2
    exit 65
  fi
else
  if test -e "$activation_marker" || test -L "$activation_marker" || test -e "$activation_manifest" || test -L "$activation_manifest"; then
    printf '%s\n' 'pre-apply requires an inactive activation state' >&2
    exit 65
  fi
  if ! prohibited_grants="$(compose_base exec -T postgres psql -v ON_ERROR_STOP=1 -U openbot -d openbot -At -c "SELECT agent_id, kind, ref FROM plugin_grants WHERE agent_id IN ('jefe-erp', 'recolector-documentos') AND kind <> 'skill' ORDER BY agent_id, kind, ref")" || test -n "$prohibited_grants"; then
    printf '%s\n' 'document staging requires no MCP, bot or other capability grants' >&2
    exit 65
  fi
  if test "$(compose_base ps -q openbot)" != "$g0_container_id" || \
    test "$(docker inspect --format '{{.Image}}' "$g0_container_id")" != "$g0_image_id" || \
    test "$(container_health "$g0_container_id")" != healthy; then
    printf '%s\n' 'pre-apply live OpenBot drifted from evidenced G0' >&2
    exit 65
  fi
fi

if ! cleanup_render; then
  printf '%s\n' 'staged verifier render cleanup failed' >&2
  exit 71
fi
printf 'staged G1 verification passed: %s\n' "$phase"
