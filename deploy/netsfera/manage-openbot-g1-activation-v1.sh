#!/usr/bin/env bash
# Persist, verify or remove the exact G1 Compose binding used by systemd.
set -euo pipefail
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
readonly marker="${OPENBOT_G1_ACTIVATION_MARKER:-/etc/netsfera/bot-zero-trust/enable-openbot-g1}"
readonly manifest="${OPENBOT_G1_ACTIVATION_MANIFEST:-/etc/netsfera/bot-zero-trust/openbot-g1-activation.manifest}"
readonly deployment_lock_file="${OPENBOT_DEPLOYMENT_LOCK_FILE:-/var/lock/openbot-deployment.lock}"
readonly expected_owner="${OPENBOT_EXPECTED_ACTIVATION_OWNER:-0:0}"
readonly expected_lock_owner="${OPENBOT_EXPECTED_LOCK_OWNER:-0:0}"
readonly accepted_g0_source_commit='ff5aa7ebd8ac798887017bfa1f5a471483b0c499'
readonly compose_helper="${OPENBOT_COMPOSE_HELPER:-/usr/local/lib/netsfera/openbot-compose-v1.sh}"

umask 077
owner_mode() { if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then stat -c '%u:%g %a' "$1"; else stat -f '%u:%g %Lp' "$1"; fi; }
inode_of() { if stat -Lc '%d:%i' "$1" >/dev/null 2>&1; then stat -Lc '%d:%i' "$1"; else stat -f '%d:%i' "$1"; fi; }
field() {
  awk -v key="$1" 'index($0,key "=")==1 { count++; value=substr($0,length(key)+2) } END { if(count!=1||value=="") exit 1; print value }' "$2"
}
prepare_lock() {
  if [[ ! -e "$deployment_lock_file" && ! -L "$deployment_lock_file" ]]; then (set -o noclobber; : >"$deployment_lock_file") 2>/dev/null || true; fi
  [[ -f "$deployment_lock_file" && ! -L "$deployment_lock_file" && "$(owner_mode "$deployment_lock_file")" == "$expected_lock_owner 600" ]] || return 65
}
prepare_lock || { printf '%s\n' 'OpenBot deployment lock file is unsafe' >&2; exit 65; }

lock_fd=9
if [[ "${1:-}" == --lock-held-fd ]]; then
  [[ "${2:-}" =~ ^[0-9]+$ && -e "/proc/$$/fd/${2}" ]] || exit 65
  lock_fd="$2"
  shift 2
  [[ "$(inode_of "/proc/$$/fd/${lock_fd}")" == "$(inode_of "$deployment_lock_file")" ]] || exit 65
else
  exec 9>"$deployment_lock_file"
fi
flock -n "$lock_fd" || { printf '%s\n' 'OpenBot deployment lock is held by another process' >&2; exit 75; }
[[ "$(inode_of "/proc/$$/fd/${lock_fd}")" == "$(inode_of "$deployment_lock_file")" ]] || exit 65

[[ "$#" -eq 2 ]] || { printf '%s\n' 'usage: manage-openbot-g1-activation-v1.sh [--lock-held-fd fd] <activate|verify|deactivate> <stage-evidence>' >&2; exit 64; }
readonly action="$1" evidence="$2"
case "$evidence" in "${incoming_directory}"/g1-stage-*.evidence) ;; *) exit 65 ;; esac
[[ -f "$evidence" && ! -L "$evidence" && "$(owner_mode "$evidence")" == "$expected_owner 600" ]] || exit 65

g0_source_commit="$(field g0_source_commit "$evidence")"
evidenced_accepted="$(field accepted_g0_source_commit "$evidence")"
g0_image_reference="$(field g0_image_reference "$evidence")"
g0_image_id="$(field g0_image_id "$evidence")"
g0_index_id="$(field g0_index_id "$evidence")"
g0_descriptor_digest="$(field g0_descriptor_digest "$evidence")"
[[ "$g0_source_commit" == "$accepted_g0_source_commit" && "$evidenced_accepted" == "$accepted_g0_source_commit" && \
  "$g0_image_id" =~ ^sha256:[a-f0-9]{64}$ && "$g0_index_id" =~ ^sha256:[a-f0-9]{64}$ && "$g0_descriptor_digest" =~ ^sha256:[a-f0-9]{64}$ && -n "$g0_image_reference" ]] || exit 65

if [[ "$action" == deactivate ]]; then
  deactivate_failed=0
  [[ "$(docker image inspect --format '{{.Id}}' "$g0_image_reference" 2>/dev/null)" == "$g0_index_id" ]] || deactivate_failed=1
  [[ "$(docker image inspect --format '{{index .Descriptor "digest"}}' "$g0_image_reference" 2>/dev/null)" == "$g0_descriptor_digest" ]] || deactivate_failed=1
  if [[ "$deactivate_failed" -eq 0 ]]; then
    rm -f "$marker" "$manifest" || deactivate_failed=1
  fi
  [[ "$deactivate_failed" -eq 0 ]] || {
    printf '%s\n' 'CRITICAL: OpenBot G1 deactivation is incomplete' >&2
    exit 70
  }
  printf '%s\n' 'OPENBOT_G1_ACTIVATION=deactivate'
  exit 0
fi
[[ "$action" == activate || "$action" == verify ]] || exit 64

candidate_commit="$(field candidate_commit "$evidence")"
candidate_image_reference="$(field candidate_image_reference "$evidence")"
candidate_image_id="$(field candidate_image_id "$evidence")"
candidate_index_id="$(field candidate_index_id "$evidence")"
candidate_descriptor_digest="$(field candidate_descriptor_digest "$evidence")"
candidate_exact_reference="$(field candidate_exact_reference "$evidence")"
candidate_overlay_path="$(field candidate_overlay_path "$evidence")"
candidate_overlay_sha256="$(field candidate_overlay_sha256 "$evidence")"
functional_overlay_path="$(field functional_overlay_path "$evidence")"
functional_overlay_sha256="$(field functional_overlay_sha256 "$evidence")"
candidate_apply_render_sha256="$(field candidate_apply_render_sha256 "$evidence")"
[[ "$candidate_commit" =~ ^[a-f0-9]{40}$ && "$candidate_image_id" =~ ^sha256:[a-f0-9]{64}$ && "$candidate_index_id" =~ ^sha256:[a-f0-9]{64}$ && "$candidate_descriptor_digest" =~ ^sha256:[a-f0-9]{64}$ && \
  "$candidate_overlay_sha256" =~ ^[a-f0-9]{64}$ && "$functional_overlay_sha256" =~ ^[a-f0-9]{64}$ && \
  "$candidate_apply_render_sha256" =~ ^[a-f0-9]{64}$ && "$functional_overlay_path" == "$g1_overlay_file" ]] || exit 65
[[ "$candidate_image_reference" =~ ^local/openbot:g1-${candidate_commit}-[a-f0-9]{16}$ ]] || exit 65
[[ "$candidate_exact_reference" == "${candidate_image_reference}@${candidate_descriptor_digest}" ]] || exit 65
case "$candidate_overlay_path" in "${incoming_directory}"/g1-stage-"${candidate_commit}"-*.image.yml) ;; *) exit 65 ;; esac
[[ -f "$functional_overlay_path" && ! -L "$functional_overlay_path" && \
  "$(sha256sum "$functional_overlay_path" | awk '{print $1}')" == "$functional_overlay_sha256" && \
  -f "$candidate_overlay_path" && ! -L "$candidate_overlay_path" ]] || exit 65
[[ "$(owner_mode "$candidate_overlay_path")" == "$expected_owner 600" && "$(sha256sum "$candidate_overlay_path" | awk '{print $1}')" == "$candidate_overlay_sha256" ]] || exit 65
[[ "$(git -C "$source_directory" rev-parse HEAD)" == "$candidate_commit" && -z "$(git -C "$source_directory" status --porcelain)" ]] || exit 65
[[ "$(docker image inspect --format '{{.Id}}' "$candidate_image_reference")" == "$candidate_index_id" ]] || exit 65
[[ "$(docker image inspect --format '{{index .Descriptor "digest"}}' "$candidate_image_reference")" == "$candidate_descriptor_digest" ]] || exit 65
[[ "$(docker image inspect --format '{{.Id}}' "$candidate_exact_reference")" == "$candidate_index_id" ]] || exit 65

render="$(mktemp)"
expected_manifest="$(mktemp)"
activation_mutation_started=0
activation_success=0
activation_signal=0
on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  temporary_cleanup_failed=0
  inactive_restore_failed=0
  rm -f "$render" "$expected_manifest" "${manifest}.new.$$" || temporary_cleanup_failed=1
  if [[ "$action" == activate && "$activation_mutation_started" -eq 1 && \
    ( "$activation_success" -ne 1 || "$activation_signal" -eq 1 || "$temporary_cleanup_failed" -ne 0 ) ]]; then
    rm -f "$manifest" || inactive_restore_failed=1
    [[ ! -e "$manifest" && ! -L "$manifest" ]] || inactive_restore_failed=1
    if [[ "$inactive_restore_failed" -ne 0 ]]; then
      printf '%s\n' 'CRITICAL: failed activation did not restore inactive G1 state' >&2
      exit 70
    fi
  fi
  [[ "$temporary_cleanup_failed" -eq 0 ]] || exit 71
  exit "$status"
}
trap on_exit EXIT
trap 'activation_signal=1; exit 130' HUP INT TERM
"$compose_helper" --lock-held-fd "$lock_fd" --reviewed-controller -p "$project_name" --env-file "$base_env_file" --env-file "$phase2_env_file" \
  -f "$base_compose_file" -f "$supervisor_compose_file" -f "$phase2_compose_file" \
  -f "$g1_overlay_file" -f "$candidate_overlay_path" config --format json >"$render"
[[ "$(sha256sum "$render" | awk '{print $1}')" == "$candidate_apply_render_sha256" ]] || exit 65
jq -e --arg expected "$candidate_exact_reference" '.services.openbot.image == $expected' "$render" >/dev/null

{
  printf 'candidate_commit=%s\n' "$candidate_commit"
  printf 'candidate_image_reference=%s\n' "$candidate_image_reference"
  printf 'candidate_index_id=%s\n' "$candidate_index_id"
  printf 'candidate_descriptor_digest=%s\n' "$candidate_descriptor_digest"
  printf 'candidate_exact_reference=%s\n' "$candidate_exact_reference"
  printf 'candidate_image_id=%s\n' "$candidate_image_id"
  printf 'functional_overlay_path=%s\n' "$functional_overlay_path"
  printf 'functional_overlay_sha256=%s\n' "$functional_overlay_sha256"
  printf 'exact_overlay_path=%s\n' "$candidate_overlay_path"
  printf 'exact_overlay_sha256=%s\n' "$candidate_overlay_sha256"
  printf 'apply_render_sha256=%s\n' "$candidate_apply_render_sha256"
} >"$expected_manifest"
chmod 600 "$expected_manifest"

verify_binding() {
  [[ ! -e "$marker" && ! -L "$marker" && -f "$manifest" && ! -L "$manifest" ]] || return 1
  [[ "$(owner_mode "$manifest")" == "$expected_owner 600" ]] || return 1
  cmp -s "$expected_manifest" "$manifest"
}

case "$action" in
  activate)
    [[ ! -e "$marker" && ! -L "$marker" ]] || exit 65
    if [[ -e "$manifest" || -L "$manifest" ]]; then
      verify_binding || exit 65
      activation_success=1
      printf '%s\n' 'OPENBOT_G1_ACTIVATION=activate'
      exit 0
    fi
    # Re-read all staged gates, including the policy that will win at boot, under
    # the same lock immediately before installing the activation binding.
    "${source_directory}/deploy/netsfera/verify-staged-g1.sh" \
      --lock-held-fd "$lock_fd" pre-apply "$evidence"
    mkdir -p "$(dirname "$manifest")"
    activation_mutation_started=1
    install -m 600 "$expected_manifest" "${manifest}.new.$$"
    mv -f "${manifest}.new.$$" "$manifest"
    verify_binding || exit 70
    activation_success=1
    ;;
  verify) verify_binding || exit 65 ;;
  *) exit 64 ;;
esac
printf 'OPENBOT_G1_ACTIVATION=%s\n' "$action"
