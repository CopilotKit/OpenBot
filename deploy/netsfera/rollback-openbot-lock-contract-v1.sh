#!/usr/bin/env bash
set -euo pipefail
set +x

if [[ "$#" -ne 1 ]]; then
  printf '%s\n' 'usage: rollback-openbot-lock-contract-v1.sh <evidence-path>' >&2
  exit 64
fi
readonly evidence_file="$1"
readonly host_root="${OPENBOT_HOST_ROOT:-}"
readonly systemctl_command="${OPENBOT_SYSTEMCTL:-systemctl}"
readonly deployment_lock_file="${OPENBOT_DEPLOYMENT_LOCK_FILE:-/var/lock/openbot-deployment.lock}"
readonly expected_owner="${OPENBOT_EXPECTED_ARTIFACT_OWNER:-0:0}"
readonly expected_lock_owner="${OPENBOT_EXPECTED_LOCK_OWNER:-0:0}"

field() { awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; found=1 } END { if (!found) exit 1 }' "$evidence_file"; }
rooted() { printf '%s%s\n' "$host_root" "$1"; }
owner_mode() { if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then stat -c '%u:%g %a' "$1"; else stat -f '%u:%g %Lp' "$1"; fi; }
inode_of() { if stat -Lc '%d:%i' "$1" >/dev/null 2>&1; then stat -Lc '%d:%i' "$1"; else stat -f '%d:%i' "$1"; fi; }

[[ -f "$evidence_file" && ! -L "$evidence_file" && "$(owner_mode "$evidence_file")" == "$expected_owner 600" ]] || {
  printf '%s\n' 'rollback evidence is missing or unsafe' >&2
  exit 65
}
umask 077
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
activation_marker="$(rooted /etc/netsfera/bot-zero-trust/enable-openbot-g1)"
activation_manifest="$(rooted /etc/netsfera/bot-zero-trust/openbot-g1-activation.manifest)"
if [[ -e "$activation_marker" || -L "$activation_marker" || -e "$activation_manifest" || -L "$activation_manifest" ]]; then
  printf '%s\n' 'deactivate G1 and restore its G0 runtime before rolling back the host lock contract' >&2
  exit 65
fi
backup_directory="$(field backup_directory)"
readonly backup_directory
[[ "$backup_directory" == "$(dirname "$evidence_file")/g0" && -d "$backup_directory" && ! -L "$backup_directory" ]] || {
  printf '%s\n' 'rollback backup directory is invalid' >&2
  exit 65
}

failed=0
restore_one() {
  local key="$1" path="$2" backup="$3" mode="$4" target
  target="$(rooted "$path")"
  if [[ "$(field "previous_${key}_present")" == 1 ]]; then
    mkdir -p "$(dirname "$target")"
    if ! install -m "$mode" "$backup_directory/$backup" "$target"; then failed=1; fi
  elif ! rm -f "$target"; then
    failed=1
  fi
}
restore_one helper /usr/local/lib/netsfera/openbot-compose-v1.sh helper.g0 700
restore_one activation_manager /usr/local/lib/netsfera/manage-openbot-g1-activation-v1.sh activation-manager.g0 700
restore_one verifier /usr/local/lib/netsfera/verify-openbot-lock-contract-v1.sh verifier.g0 700
restore_one rollback /usr/local/lib/netsfera/rollback-openbot-lock-contract-v1.sh rollback.g0 700
restore_one dropin /etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf dropin.g0 600
if ! "$systemctl_command" daemon-reload; then failed=1; fi

if [[ "$failed" -ne 0 ]]; then
  printf '%s\n' 'CRITICAL: OpenBot lock-contract rollback is incomplete' >&2
  exit 70
fi
printf 'OPENBOT_LOCK_ROLLBACK_EVIDENCE=%s\n' "$evidence_file"
