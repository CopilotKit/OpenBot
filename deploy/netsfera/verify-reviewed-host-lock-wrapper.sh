#!/usr/bin/env bash
# Bind the transferred installer and its package to one reviewed bundle commit.
set -euo pipefail
set +x

if [[ "$#" -ne 5 ]]; then
  printf '%s\n' 'usage: verify-reviewed-host-lock-wrapper.sh <bundle-path> <bundle-sha256> <advertised-ref> <target-commit> <installer-script-path>' >&2
  exit 64
fi
readonly bundle_path="$1" expected_bundle_sha256="$2" advertised_ref="$3" target_commit="$4" installer_script_path="$5"
readonly source_directory="${OPENBOT_SOURCE_DIR:-/opt/openbot/source}"
readonly expected_installer_owner="${OPENBOT_EXPECTED_INSTALLER_OWNER:-0:0}"
temporary_directory=''

owner_mode() { if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then stat -c '%u:%g %a' "$1"; else stat -f '%u:%g %Lp' "$1"; fi; }
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  failed=0
  rm -rf "$temporary_directory" || failed=1
  rm -f "$bundle_path" "$installer_script_path" || failed=1
  if [[ "$status" -eq 70 ]]; then exit 70; fi
  if [[ "$failed" -ne 0 || -e "$bundle_path" || -e "$installer_script_path" ]]; then exit 71; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

[[ "$target_commit" =~ ^[a-f0-9]{40}$ && "$advertised_ref" == "refs/netsfera-review/${target_commit}" ]] || exit 65
[[ -f "$bundle_path" && -f "$installer_script_path" && -d "$source_directory/.git" ]] || exit 65
[[ "$(owner_mode "$installer_script_path")" == "$expected_installer_owner 700" ]] || exit 65
[[ "$expected_bundle_sha256" =~ ^[a-f0-9]{64}$ && "$(sha256sum "$bundle_path" | awk '{print $1}')" == "$expected_bundle_sha256" ]] || exit 65
git -C "$source_directory" bundle verify "$bundle_path" >/dev/null
[[ "$(git -C "$source_directory" bundle list-heads "$bundle_path" | awk -v ref="$advertised_ref" '$2 == ref {print $1}')" == "$target_commit" ]] || exit 65
git -C "$source_directory" fetch --no-tags "$bundle_path" "${advertised_ref}:refs/heads/host-lock-reviewed-artifact"
[[ "$(git -C "$source_directory" rev-parse refs/heads/host-lock-reviewed-artifact)" == "$target_commit" ]] || exit 65

temporary_directory="$(mktemp -d)"
chmod 700 "$temporary_directory"
declare -a artifacts=(
  install-openbot-lock-contract.sh
  openbot-compose-lock-v1.sh
  manage-openbot-g1-activation-v1.sh
  verify-openbot-lock-contract-v1.sh
  rollback-openbot-lock-contract-v1.sh
  netsfera-openbot-deployment-lock.conf
)
for name in "${artifacts[@]}"; do
  blob="$(git -C "$source_directory" rev-parse "${target_commit}:deploy/netsfera/${name}")"
  git -C "$source_directory" cat-file blob "$blob" >"$temporary_directory/$name"
done
chmod 700 "$temporary_directory"/*.sh
chmod 600 "$temporary_directory/netsfera-openbot-deployment-lock.conf"
[[ "$(sha256sum "$installer_script_path" | awk '{print $1}')" == "$(sha256sum "$temporary_directory/install-openbot-lock-contract.sh" | awk '{print $1}')" ]] || {
  printf '%s\n' 'reviewed host-lock installer bytes do not match the verified commit' >&2
  exit 65
}
"$installer_script_path" "$target_commit" "$temporary_directory"
