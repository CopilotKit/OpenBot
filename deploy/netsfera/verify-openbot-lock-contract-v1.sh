#!/usr/bin/env bash
set -euo pipefail
set +x

if [[ "$#" -ne 3 || "$1" != installed ]]; then
  printf '%s\n' 'usage: verify-openbot-lock-contract-v1.sh installed <target-commit> <evidence-path>' >&2
  exit 64
fi
readonly target_commit="$2"
readonly evidence_file="$3"
readonly host_root="${OPENBOT_HOST_ROOT:-}"
readonly systemctl_command="${OPENBOT_SYSTEMCTL:-systemctl}"
readonly expected_owner="${OPENBOT_EXPECTED_ARTIFACT_OWNER:-0:0}"

rooted() { printf '%s%s\n' "$host_root" "$1"; }
owner_mode() {
  if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then stat -c '%u:%g %a' "$1"; else stat -f '%u:%g %Lp' "$1"; fi
}
field() { awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; found=1 } END { if (!found) exit 1 }' "$evidence_file"; }

[[ "$target_commit" =~ ^[a-f0-9]{40}$ ]] || exit 65
[[ -f "$evidence_file" && ! -L "$evidence_file" && "$(owner_mode "$evidence_file")" == "$expected_owner 600" ]] || {
  printf '%s\n' 'lock-contract evidence owner or mode is invalid' >&2
  exit 65
}
[[ "$(field target_commit)" == "$target_commit" ]] || {
  printf '%s\n' 'lock-contract evidence targets another commit' >&2
  exit 65
}

declare -a records=(
  'helper_sha256:/usr/local/lib/netsfera/openbot-compose-v1.sh:700'
  'activation_manager_sha256:/usr/local/lib/netsfera/manage-openbot-g1-activation-v1.sh:700'
  'verifier_sha256:/usr/local/lib/netsfera/verify-openbot-lock-contract-v1.sh:700'
  'rollback_sha256:/usr/local/lib/netsfera/rollback-openbot-lock-contract-v1.sh:700'
  'dropin_sha256:/etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf:600'
)
for record in "${records[@]}"; do
  IFS=: read -r key path mode <<<"$record"
  installed="$(rooted "$path")"
  [[ -f "$installed" && ! -L "$installed" ]] || { printf 'missing lock-contract artifact: %s\n' "$path" >&2; exit 65; }
  [[ "$(sha256sum "$installed" | awk '{print $1}')" == "$(field "$key")" ]] || {
    printf 'lock-contract artifact digest mismatch: %s\n' "$path" >&2; exit 65;
  }
  [[ "$(owner_mode "$installed")" == "$expected_owner $mode" ]] || {
    printf 'lock-contract artifact owner or mode mismatch: %s\n' "$path" >&2; exit 65;
  }
done

effective_property() { "$systemctl_command" show netsfera-openbot.service --property="$1" --value; }
[[ "$(effective_property RefuseManualStop)" == yes ]] || {
  printf '%s\n' 'manual systemd stop/restart is not effectively fail-closed' >&2
  exit 65
}
[[ "$(effective_property Environment)" == 'OPENBOT_DEPLOYMENT_LOCK_FILE=/var/lock/openbot-deployment.lock' ]] || {
  printf '%s\n' 'netsfera-openbot.service does not declare the shared deployment lock' >&2
  exit 65
}
[[ "$(effective_property FragmentPath)" == /etc/systemd/system/netsfera-openbot.service ]] || {
  printf '%s\n' 'effective systemd fragment is not the reviewed host unit' >&2
  exit 65
}
grep -Eq '(^| )/etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf( |$)' <<<"$(effective_property DropInPaths)" || {
  printf '%s\n' 'effective systemd drop-in set omits the deployment lock contract' >&2
  exit 65
}
exec_start="$(effective_property ExecStart)"
exec_stop="$(effective_property ExecStop)"
exec_start_pre="$(effective_property ExecStartPre)"
[[ "$(grep -Fc 'argv[]=' <<<"$exec_start")" -eq 1 && "$exec_start" == *'path=/usr/local/lib/netsfera/openbot-compose-v1.sh ;'* && "$exec_start" == *'argv[]=/usr/local/lib/netsfera/openbot-compose-v1.sh up --detach --remove-orphans ;'* ]] || {
  printf '%s\n' 'effective ExecStart bypasses the locked Compose helper' >&2
  exit 65
}
[[ "$(grep -Fc 'argv[]=' <<<"$exec_stop")" -eq 1 && "$exec_stop" == *'path=/usr/local/lib/netsfera/openbot-compose-v1.sh ;'* && "$exec_stop" == *'argv[]=/usr/local/lib/netsfera/openbot-compose-v1.sh down ;'* ]] || {
  printf '%s\n' 'effective ExecStop bypasses the locked Compose helper' >&2
  exit 65
}
[[ "$(grep -Fc 'argv[]=' <<<"$exec_start_pre")" -eq 2 && \
  "$exec_start_pre" == *'path=/usr/local/lib/netsfera/openbot-compose-v1.sh ;'* && \
  "$exec_start_pre" == *'path=/usr/local/lib/netsfera/assert-no-bootstrap-residue-v1.sh ;'* && \
  "$exec_start_pre" == *'argv[]=/usr/local/lib/netsfera/openbot-compose-v1.sh config --quiet ;'* && \
  "$exec_start_pre" == *'argv[]=/usr/local/lib/netsfera/assert-no-bootstrap-residue-v1.sh --directory /opt/openbot --compose docker-compose.yml --service bot-backend-ts --authkey /run/netsfera/bot-backend.authkey ;'* ]] || {
  printf '%s\n' 'effective ExecStartPre differs from the reviewed host boundary' >&2
  exit 65
}
binds_to="$(effective_property BindsTo)"
read -r -a bind_dependencies <<<"$binds_to"
[[ "${#bind_dependencies[@]}" -eq 3 ]] || {
  printf '%s\n' 'effective BindsTo contains unreviewed dependencies' >&2
  exit 65
}
for dependency in netsfera-docker-network-prepare.service netsfera-openbot-computer-network.service netsfera-openbot-computer-boundary.service; do
  grep -Eq "(^| )${dependency}( |$)" <<<"$binds_to" || {
    printf '%s\n' 'effective BindsTo omits a reviewed OpenBot boundary' >&2
    exit 65
  }
done
[[ -z "$(effective_property Job)" && "$(effective_property ActiveState)" == active && "$(effective_property SubState)" == exited ]] || {
  printf '%s\n' 'netsfera-openbot.service is not job-free and stable' >&2
  exit 65
}
printf 'OPENBOT_LOCK_CONTRACT_VERIFIED=%s\n' "$target_commit"
