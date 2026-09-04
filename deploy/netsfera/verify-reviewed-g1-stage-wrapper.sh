#!/bin/sh
# Trusted remote wrapper: bind transferred G1 staging bytes to the exact blob
# carried by the verified review bundle and always remove transferred artifacts.
set -eu
set +x

if test "$#" -ne 5; then
  printf '%s\n' 'usage: verify-reviewed-g1-stage-wrapper.sh <bundle-path> <bundle-sha256> <advertised-ref> <target-commit> <staging-script-path>' >&2
  exit 64
fi

readonly bundle_path="$1"
readonly expected_bundle_sha256="$2"
readonly advertised_ref="$3"
readonly target_commit="$4"
readonly staging_script_path="$5"
readonly source_directory="${OPENBOT_SOURCE_DIR:-/opt/openbot/source}"
readonly staging_script_repo_path=deploy/netsfera/stage-reviewed-g1.sh
readonly expected_script_owner="${OPENBOT_EXPECTED_STAGE_SCRIPT_OWNER:-0:0}"
child_pid=''

file_owner_mode() {
  if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then
    stat -c '%u:%g %a' "$1"
  else
    stat -f '%u:%g %Lp' "$1"
  fi
}

# shellcheck disable=SC2329 # invoked by the EXIT/signal trap path
clean_up_transferred_artifacts() {
  cleanup_failed=0
  if ! rm -f "$bundle_path"; then cleanup_failed=1; fi
  if ! rm -f "$staging_script_path"; then cleanup_failed=1; fi
  if test -e "$bundle_path" || test -e "$staging_script_path"; then cleanup_failed=1; fi
  return "$cleanup_failed"
}

# shellcheck disable=SC2329 # invoked by trap
on_exit() {
  status=$?
  cleanup_status=0
  trap - EXIT HUP INT TERM
  set +e
  if test -n "$child_pid"; then
    kill -TERM "$child_pid" >/dev/null 2>&1 || true
    wait "$child_pid" >/dev/null 2>&1 || true
    child_pid=''
  fi
  clean_up_transferred_artifacts || cleanup_status=$?
  if test "$status" -eq 70; then
    exit 70
  fi
  if test "$cleanup_status" -ne 0; then
    printf '%s\n' 'reviewed G1 wrapper cleanup is incomplete' >&2
    exit 71
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

if test "$(printf '%s' "$target_commit" | grep -Ec '^[a-f0-9]{40}$')" -ne 1 || \
  test "$advertised_ref" != "refs/netsfera-review/${target_commit}"; then
  printf '%s\n' 'reviewed advertised ref is not canonical for the requested commit' >&2
  exit 65
fi
if test ! -f "$bundle_path" || test ! -f "$staging_script_path" || test ! -d "$source_directory/.git"; then
  printf '%s\n' 'reviewed artifact, staging script, or source checkout is missing' >&2
  exit 65
fi
if test "$(file_owner_mode "$staging_script_path")" != "${expected_script_owner} 700"; then
  printf '%s\n' 'reviewed staging script owner or mode is not approved' >&2
  exit 65
fi
if test "$(printf '%s' "$expected_bundle_sha256" | grep -Ec '^[a-f0-9]{64}$')" -ne 1 || \
  test "$(sha256sum "$bundle_path" | awk '{ print $1 }')" != "$expected_bundle_sha256"; then
  printf '%s\n' 'reviewed bundle SHA-256 mismatch' >&2
  exit 65
fi
git -C "$source_directory" bundle verify "$bundle_path" >/dev/null
advertised_commit="$(git -C "$source_directory" bundle list-heads "$bundle_path" | awk -v ref="$advertised_ref" '$2 == ref { print $1 }')"
if test "$advertised_commit" != "$target_commit"; then
  printf '%s\n' 'reviewed bundle does not advertise the requested commit' >&2
  exit 65
fi
git -C "$source_directory" fetch --no-tags "$bundle_path" "${advertised_ref}:refs/heads/g1-reviewed-artifact"
if test "$(git -C "$source_directory" rev-parse refs/heads/g1-reviewed-artifact)" != "$target_commit"; then
  printf '%s\n' 'verified review ref does not resolve to the requested commit' >&2
  exit 65
fi
expected_blob="$(git -C "$source_directory" rev-parse "${target_commit}:${staging_script_repo_path}")"
expected_script_sha256="$(git -C "$source_directory" cat-file blob "$expected_blob" | sha256sum | awk '{ print $1 }')"
actual_script_sha256="$(sha256sum "$staging_script_path" | awk '{ print $1 }')"
if test "$actual_script_sha256" != "$expected_script_sha256"; then
  printf '%s\n' 'reviewed staging script bytes do not match the verified commit' >&2
  exit 65
fi

"$staging_script_path" "$bundle_path" "$expected_bundle_sha256" "$advertised_ref" "$target_commit" &
child_pid=$!
if wait "$child_pid"; then
  child_status=0
else
  child_status=$?
fi
child_pid=''
exit "$child_status"
