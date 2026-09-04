#!/bin/sh
# Bind a transferred incident-recovery script to its exact reviewed commit.
set -eu
set +x
test "$#" -eq 7 || { printf '%s\n' 'usage: verify-reviewed-g0-recovery-wrapper.sh <bundle> <bundle-sha256> <advertised-ref> <fix-commit> <recovery-script> <expected-live-container-id> <expected-live-config-id>' >&2; exit 64; }
bundle_path="$1"; bundle_sha="$2"; advertised_ref="$3"; target_commit="$4"; script_path="$5"; live_container="$6"; live_config="$7"
source_directory="${OPENBOT_SOURCE_DIR:-/opt/openbot/source}"
repo_path=deploy/netsfera/recover-openbot-g0-baseline-v1.sh
expected_owner="${OPENBOT_EXPECTED_RECOVERY_SCRIPT_OWNER:-0:0}"
child_pid=''
owner_mode() { if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then stat -c '%u:%g %a' "$1"; else stat -f '%u:%g %Lp' "$1"; fi; }
# shellcheck disable=SC2329 # invoked by EXIT and signal traps
cleanup() {
  status=$?; trap - EXIT HUP INT TERM; set +e
  if test -n "$child_pid"; then kill -TERM "$child_pid" >/dev/null 2>&1 || true; wait "$child_pid" >/dev/null 2>&1 || true; child_pid=''; fi
  rm -f "$bundle_path" "$script_path" || exit 71
  test "$status" -eq 70 && exit 70
  exit "$status"
}
trap cleanup EXIT HUP INT TERM
test "$advertised_ref" = "refs/netsfera-review/${target_commit}" || exit 65
test "$(printf '%s' "$bundle_sha" | grep -Ec '^[a-f0-9]{64}$')" -eq 1 || exit 65
test -f "$bundle_path" -a -f "$script_path" -a "$(owner_mode "$script_path")" = "$expected_owner 700" || exit 65
test "$(sha256sum "$bundle_path" | awk '{print $1}')" = "$bundle_sha" || exit 65
git -C "$source_directory" bundle verify "$bundle_path" >/dev/null
test "$(git -C "$source_directory" bundle list-heads "$bundle_path" | awk -v ref="$advertised_ref" '$2==ref{print $1}')" = "$target_commit" || exit 65
git -C "$source_directory" fetch --no-tags "$bundle_path" "${advertised_ref}:refs/heads/g0-recovery-reviewed-artifact"
blob="$(git -C "$source_directory" rev-parse "${target_commit}:${repo_path}")"
expected="$(git -C "$source_directory" cat-file blob "$blob" | sha256sum | awk '{print $1}')"
test "$(sha256sum "$script_path" | awk '{print $1}')" = "$expected" || exit 65
"$script_path" "$live_container" "$live_config" &
child_pid=$!
if wait "$child_pid"; then child_status=0; else child_status=$?; fi
child_pid=''
exit "$child_status"
