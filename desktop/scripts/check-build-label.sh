#!/usr/bin/env bash
# Checks that a built Desktop binary names the commit it was built from, without `-dirty`.
#
# build.rs labels the app (Settings > This computer, About OpenBot) with the commit and marks it
# `-dirty` when tracked files differ from that commit. A CI build starts from a clean checkout, so a
# dirty label there means a build step changed a tracked file. Cargo rewriting Cargo.lock into its
# own format did exactly that, and every installer said "-dirty" although its commit was clean.
#
# Usage: check-build-label.sh <binary> [short commit]
# The commit defaults to `git rev-parse --short HEAD`, the same command build.rs runs.
set -euo pipefail

binary="${1:?the built binary}"
commit="${2:-$(git rev-parse --short HEAD)}"

if grep -aqF -- "${commit}-dirty" "$binary"; then
  echo "::error::$binary says it was built from ${commit}-dirty. A build step changed a tracked file:" >&2
  git status --porcelain --untracked-files=no >&2 || true
  exit 1
fi
if ! grep -aqF -- "$commit" "$binary"; then
  echo "::error::$binary does not name the commit it was built from, $commit." >&2
  exit 1
fi
echo "$binary was built from $commit, with no tracked file changed."
