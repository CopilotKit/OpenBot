#!/usr/bin/env bash
set -euo pipefail
set +x

if [[ "$#" -ne 2 ]]; then
  printf '%s\n' 'usage: install-openbot-lock-contract.sh <target-commit> <reviewed-package-directory>' >&2
  exit 64
fi
readonly target_commit="$1"
readonly package_directory="$2"
readonly host_root="${OPENBOT_HOST_ROOT:-}"
readonly incoming_directory="${OPENBOT_INCOMING_DIR:-/root/openbot-incoming}"
readonly systemctl_command="${OPENBOT_SYSTEMCTL:-systemctl}"
readonly deployment_lock_file="${OPENBOT_DEPLOYMENT_LOCK_FILE:-/var/lock/openbot-deployment.lock}"
readonly expected_lock_owner="${OPENBOT_EXPECTED_LOCK_OWNER:-0:0}"
readonly drain_attempts="${OPENBOT_LOCK_DRAIN_ATTEMPTS:-30}"
readonly drain_sleep_seconds="${OPENBOT_LOCK_DRAIN_SLEEP_SECONDS:-1}"

[[ "$target_commit" =~ ^[a-f0-9]{40}$ ]] || exit 65
for name in install-openbot-lock-contract.sh openbot-compose-lock-v1.sh manage-openbot-g1-activation-v1.sh verify-openbot-lock-contract-v1.sh rollback-openbot-lock-contract-v1.sh netsfera-openbot-deployment-lock.conf; do
  [[ -f "$package_directory/$name" && ! -L "$package_directory/$name" ]] || {
    printf 'reviewed lock-contract package is missing %s\n' "$name" >&2
    exit 65
  }
done
[[ "$drain_attempts" =~ ^[1-9][0-9]*$ && "$drain_sleep_seconds" =~ ^[0-9]+$ ]] || exit 65

umask 077
owner_mode() { if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then stat -c '%u:%g %a' "$1"; else stat -f '%u:%g %Lp' "$1"; fi; }
inode_of() { if stat -Lc '%d:%i' "$1" >/dev/null 2>&1; then stat -Lc '%d:%i' "$1"; else stat -f '%d:%i' "$1"; fi; }
if [[ ! -e "$deployment_lock_file" && ! -L "$deployment_lock_file" ]]; then
  (set -o noclobber; : >"$deployment_lock_file") 2>/dev/null || true
fi
[[ -f "$deployment_lock_file" && ! -L "$deployment_lock_file" && \
  "$(owner_mode "$deployment_lock_file")" == "$expected_lock_owner 600" ]] || {
  printf '%s\n' 'OpenBot deployment lock file is unsafe' >&2
  exit 65
}

exec 9>"$deployment_lock_file"
if ! flock -n 9; then
  printf '%s\n' 'OpenBot deployment lock is held by a concurrent operation' >&2
  exit 75
fi
[[ "$(inode_of "$deployment_lock_file")" == "$(inode_of "/proc/$$/fd/9")" ]] || {
  printf '%s\n' 'OpenBot deployment lock identity changed during acquisition' >&2
  exit 65
}

nonce="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
evidence_directory="${incoming_directory}/openbot-lock-contract-${target_commit}-${nonce}-$$"
backup_directory="${evidence_directory}/g0"
evidence_file="${evidence_directory}/evidence"
mkdir -m 700 "$evidence_directory" "$backup_directory"

rooted() { printf '%s%s\n' "$host_root" "$1"; }
helper_target="$(rooted /usr/local/lib/netsfera/openbot-compose-v1.sh)"
activation_manager_target="$(rooted /usr/local/lib/netsfera/manage-openbot-g1-activation-v1.sh)"
verifier_target="$(rooted /usr/local/lib/netsfera/verify-openbot-lock-contract-v1.sh)"
rollback_target="$(rooted /usr/local/lib/netsfera/rollback-openbot-lock-contract-v1.sh)"
dropin_target="$(rooted /etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf)"

backup_one() {
  local key="$1" source="$2" backup="$3"
  if [[ -f "$source" && ! -L "$source" ]]; then
    install -m 600 "$source" "$backup_directory/$backup"
    printf 'previous_%s_present=1\n' "$key" >>"$evidence_file"
  else
    printf 'previous_%s_present=0\n' "$key" >>"$evidence_file"
  fi
}

{
  printf 'target_commit=%s\n' "$target_commit"
  printf 'backup_directory=%s\n' "$backup_directory"
} >"$evidence_file"
backup_one helper "$helper_target" helper.g0
backup_one activation_manager "$activation_manager_target" activation-manager.g0
backup_one verifier "$verifier_target" verifier.g0
backup_one rollback "$rollback_target" rollback.g0
backup_one dropin "$dropin_target" dropin.g0
{
  printf 'helper_sha256=%s\n' "$(sha256sum "$package_directory/openbot-compose-lock-v1.sh" | awk '{print $1}')"
  printf 'activation_manager_sha256=%s\n' "$(sha256sum "$package_directory/manage-openbot-g1-activation-v1.sh" | awk '{print $1}')"
  printf 'verifier_sha256=%s\n' "$(sha256sum "$package_directory/verify-openbot-lock-contract-v1.sh" | awk '{print $1}')"
  printf 'rollback_sha256=%s\n' "$(sha256sum "$package_directory/rollback-openbot-lock-contract-v1.sh" | awk '{print $1}')"
  printf 'dropin_sha256=%s\n' "$(sha256sum "$package_directory/netsfera-openbot-deployment-lock.conf" | awk '{print $1}')"
} >>"$evidence_file"
chmod 600 "$evidence_file"

mutation_started=0
success=0
runtime_snapshot=''
effective_property() { "$systemctl_command" show netsfera-openbot.service --property="$1" --value; }
wait_for_stable_unit() {
  local attempt
  for ((attempt = 1; attempt <= drain_attempts; attempt++)); do
    if [[ -z "$(effective_property Job)" && "$(effective_property ActiveState)" == active && "$(effective_property SubState)" == exited ]]; then
      return 0
    fi
    sleep "$drain_sleep_seconds"
  done
  return 1
}
capture_runtime() {
  local container_id runtime
  container_id="$(docker ps --no-trunc \
    --filter label=com.docker.compose.project=openbot \
    --filter label=com.docker.compose.service=openbot \
    --format '{{.ID}}')"
  [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] || return 1
  runtime="$(docker inspect --format '{{.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
  [[ "$runtime" =~ ^sha256:[a-f0-9]{64}\|healthy$ ]] || return 1
  printf '%s|%s\n' "$container_id" "$runtime"
}
restore_previous() {
  local failed=0
  restore_one() {
    local key="$1" target="$2" backup="$3" mode="$4"
    if grep -Fqx "previous_${key}_present=1" "$evidence_file"; then
      mkdir -p "$(dirname "$target")"
      install -m "$mode" "$backup_directory/$backup" "$target" || failed=1
    else
      rm -f "$target" || failed=1
    fi
  }
  restore_one helper "$helper_target" helper.g0 700
  restore_one activation_manager "$activation_manager_target" activation-manager.g0 700
  restore_one verifier "$verifier_target" verifier.g0 700
  restore_one rollback "$rollback_target" rollback.g0 700
  restore_one dropin "$dropin_target" dropin.g0 600
  "$systemctl_command" daemon-reload || failed=1
  if [[ -n "$runtime_snapshot" ]]; then
    wait_for_stable_unit || failed=1
    [[ "$(capture_runtime 2>/dev/null)" == "$runtime_snapshot" ]] || failed=1
  fi
  [[ "$failed" -eq 0 ]]
}
on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [[ "$success" -ne 1 && "$mutation_started" -eq 1 ]]; then
    if ! restore_previous; then
      printf '%s\n' 'CRITICAL: lock-contract installation rollback is incomplete' >&2
      exit 70
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

mkdir -p "$(dirname "$helper_target")" "$(dirname "$dropin_target")"
mutation_started=1
install -m 600 "$package_directory/netsfera-openbot-deployment-lock.conf" "$dropin_target"
"$systemctl_command" daemon-reload
[[ "$(effective_property RefuseManualStop)" == yes ]] || {
  printf '%s\n' 'manual systemd stop/restart did not become effectively fail-closed' >&2
  exit 65
}
[[ "$(effective_property FragmentPath)" == /etc/systemd/system/netsfera-openbot.service && \
  "$(effective_property DropInPaths)" == *'/etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf'* ]] || {
  printf '%s\n' 'deployment lock drop-in did not become effective' >&2
  exit 65
}
wait_for_stable_unit || {
  printf '%s\n' 'netsfera-openbot.service did not drain to active/exited' >&2
  exit 65
}
runtime_snapshot="$(capture_runtime)" || {
  printf '%s\n' 'could not capture a unique healthy OpenBot runtime before helper replacement' >&2
  exit 65
}
install -m 700 "$package_directory/openbot-compose-lock-v1.sh" "$helper_target"
install -m 700 "$package_directory/manage-openbot-g1-activation-v1.sh" "$activation_manager_target"
install -m 700 "$package_directory/verify-openbot-lock-contract-v1.sh" "$verifier_target"
install -m 700 "$package_directory/rollback-openbot-lock-contract-v1.sh" "$rollback_target"
"$verifier_target" installed "$target_commit" "$evidence_file" >/dev/null
[[ "$(capture_runtime)" == "$runtime_snapshot" ]] || {
  printf '%s\n' 'OpenBot runtime changed during lock-contract installation' >&2
  exit 70
}
success=1
printf 'OPENBOT_LOCK_EVIDENCE=%s\n' "$evidence_file"
