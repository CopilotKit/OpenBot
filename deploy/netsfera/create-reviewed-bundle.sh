#!/usr/bin/env bash
# Produce an independently-verifiable review artifact without publishing a ref.
set -Eeuo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <reviewed-commit-or-ref> <bundle-output-path>" >&2
  exit 64
fi

reviewed_input="$1"
bundle_output="$2"
repository_root="$(git rev-parse --show-toplevel)"
reviewed_commit="$(git -C "$repository_root" rev-parse --verify "${reviewed_input}^{commit}")"
advertised_ref="refs/netsfera-review/${reviewed_commit}"

if [ -e "$bundle_output" ]; then
  echo "refusing to overwrite bundle output" >&2
  exit 65
fi

umask 077
temporary_directory="$(mktemp -d)"
temporary_bundle="${temporary_directory}/reviewed.bundle"
advertised_ref_created=0

cleanup() {
  local status=$?
  if [ "$advertised_ref_created" -eq 1 ]; then
    git -C "$repository_root" update-ref -d "$advertised_ref" || true
  fi
  rm -rf "$temporary_directory"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

git -C "$repository_root" update-ref "$advertised_ref" "$reviewed_commit"
advertised_ref_created=1
git -C "$repository_root" bundle create "$temporary_bundle" "$advertised_ref"
git -C "$repository_root" update-ref -d "$advertised_ref"
advertised_ref_created=0
git -C "$repository_root" bundle verify "$temporary_bundle" >/dev/null

advertised_commit="$(git -C "$repository_root" bundle list-heads "$temporary_bundle" | awk -v ref="$advertised_ref" '$2 == ref { print $1 }')"
if [ "$advertised_commit" != "$reviewed_commit" ]; then
  echo "bundle advertised ref does not resolve to the reviewed commit" >&2
  exit 66
fi

install -m 600 "$temporary_bundle" "$bundle_output"
bundle_sha256="$(sha256sum "$bundle_output" | awk '{ print $1 }')"
printf '%s %s\n' "$bundle_output" "$bundle_sha256"
