#!/usr/bin/env bash
# Puts the security floor (shared/security-floor.ts) on a release, beside its latest.json, where the
# apps read it: releases/latest/download/security-floor.json, and downloads.copilotkit.ai/latest/,
# which Downloads sync copies from the Latest release.
#
# Usage: release-security-floor.sh <tag> [<file>]
#   With a file: the floor the Security floor workflow just signed (.github/workflows/security-floor.yml).
#   Without one: the floor on the current Latest release, carried to <tag> as it becomes Latest
#   (scripts/release-make-latest.sh), so a new release never drops the floor.
#
# The floor goes up only when <tag> has none or has one with a lower serial: like the apps, the
# release keeps the highest. This places a file and trusts nothing in it. Every app verifies the
# signature itself and ignores a floor that does not verify.
#
# Env: GITHUB_REPOSITORY and GH_TOKEN, for `gh`; the token needs contents: write.
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository}"
tag="${1:?usage: release-security-floor.sh <tag> [<file>]}"
file="${2:-}"
name=security-floor.json
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/security-floor.XXXXXX")"

# The serial a floor's payload names, or 0 when it names none.
serial() {
  jq -r '.payload // ""' "$1" | openssl base64 -d -A 2> /dev/null | jq -r '.serial // 0' 2> /dev/null || echo 0
}

# Whether a release carries the floor. Assigned first: a failure inside a command's argument would
# not stop the script.
has() {
  local names
  names="$(gh release view "$1" -R "$GITHUB_REPOSITORY" --json assets --jq '.assets[].name')"
  grep -qxF "$name" <<<"$names"
}

if [ -z "$file" ]; then
  latest="$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name 2> /dev/null || true)"
  if [ -z "$latest" ] || [ "$latest" = "$tag" ] || ! has "$latest"; then
    echo "No security floor to carry to $tag."
    exit 0
  fi
  mkdir "$work/latest"
  gh release download "$latest" -R "$GITHUB_REPOSITORY" --pattern "$name" --dir "$work/latest" --clobber
  file="$work/latest/$name"
fi

if [ ! -s "$file" ]; then
  echo "::error::$file is not a security floor."
  exit 1
fi
new="$(serial "$file")"
if ! [[ "$new" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::$file names no serial, so it is not a security floor."
  exit 1
fi

if has "$tag"; then
  mkdir "$work/held"
  gh release download "$tag" -R "$GITHUB_REPOSITORY" --pattern "$name" --dir "$work/held" --clobber
  held="$(serial "$work/held/$name")"
  if [[ "$held" =~ ^[0-9]+$ ]] && [ "$held" -ge "$new" ]; then
    echo "$tag already carries security floor $held, so floor $new is not put there."
    exit 0
  fi
fi

# The upload names the asset after the file, so it goes up from a copy with the published name.
mkdir -p "$work/upload"
cp "$file" "$work/upload/$name"
gh release upload "$tag" -R "$GITHUB_REPOSITORY" "$work/upload/$name" --clobber
echo "$tag now carries security floor $new."
