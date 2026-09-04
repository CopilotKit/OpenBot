#!/usr/bin/env bash
# Trusted remote wrapper: never execute transferred promotion bytes before
# comparing them to the exact blob carried by the verified review bundle.
set -Eeuo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <bundle-path> <bundle-sha256> <advertised-ref> <target-commit> <promotion-script-path>" >&2
  exit 64
fi

bundle_path="$1"
expected_bundle_sha256="$2"
advertised_ref="$3"
target_commit="$4"
promotion_script_path="$5"
source_directory="${OPENBOT_SOURCE_DIR:-/opt/openbot/source}"
promotion_script_repo_path="deploy/netsfera/promote-reviewed-g0.sh"

if [ ! -f "$bundle_path" ] || [ ! -f "$promotion_script_path" ] || [ ! -d "$source_directory/.git" ]; then
  echo "reviewed artifact, promotion script, or source checkout is missing" >&2
  exit 65
fi
if ! [[ "$expected_bundle_sha256" =~ ^[a-f0-9]{64}$ ]] || [ "$(sha256sum "$bundle_path" | awk '{ print $1 }')" != "$expected_bundle_sha256" ]; then
  echo "reviewed bundle SHA-256 mismatch" >&2
  exit 65
fi
git -C "$source_directory" bundle verify "$bundle_path" >/dev/null
advertised_commit="$(git -C "$source_directory" bundle list-heads "$bundle_path" | awk -v ref="$advertised_ref" '$2 == ref { print $1 }')"
if [ "$advertised_commit" != "$target_commit" ]; then
  echo "reviewed bundle does not advertise the requested commit" >&2
  exit 65
fi
git -C "$source_directory" fetch --no-tags "$bundle_path" "${advertised_ref}:refs/heads/g0-reviewed-artifact"
if [ "$(git -C "$source_directory" rev-parse refs/heads/g0-reviewed-artifact)" != "$target_commit" ]; then
  echo "verified review ref does not resolve to the requested commit" >&2
  exit 65
fi
expected_blob="$(git -C "$source_directory" rev-parse "${target_commit}:${promotion_script_repo_path}")"
expected_script_sha256="$(git -C "$source_directory" cat-file blob "$expected_blob" | sha256sum | awk '{ print $1 }')"
actual_script_sha256="$(sha256sum "$promotion_script_path" | awk '{ print $1 }')"
if [ "$actual_script_sha256" != "$expected_script_sha256" ]; then
  echo "reviewed promotion script bytes do not match the verified commit" >&2
  exit 65
fi

exec "$promotion_script_path" "$bundle_path" "$expected_bundle_sha256" "$advertised_ref" "$target_commit"
