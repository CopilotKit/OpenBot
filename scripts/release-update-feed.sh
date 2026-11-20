#!/usr/bin/env bash
# Writes this signing run's platforms into the release's latest.json, keeping the other run's.
#
# Usage: release-update-feed.sh <platform>=<file> ...
#        release-update-feed.sh --platforms    every platform a stable release's feed must list
#
# Run from the repository root by the attach job of Desktop macOS signing (darwin-aarch64 and
# darwin-x86_64, each its .app.tar.gz) and of Desktop Windows signing (windows-x86_64, its signed
# -setup.exe), after each has uploaded the files it names.
#
# Env:
#   RELEASE_TAG        the release, such as v0.3.0
#   VERSION            the version those files are, such as 0.3.0
#   GITHUB_REPOSITORY  and GH_TOKEN, for `gh`
#
# latest.json is the whole updater. It names a version and, for each platform, the URL of the file
# the updater installs there and that file's minisign signature, which is the content of the
# `<file>.sig` beside it. The app refuses any file whose signature does not verify against the
# public key it was built with. Tauri reads the whole feed before it looks for its own platform, so
# every entry must be complete.
#
# Two runs write one file. Each reads the latest.json already on the release, keeps the other's
# platforms when it describes the same version, replaces its own, and uploads it again. The two
# attach jobs share the concurrency group `release-attach-<tag>`, so they never run at once and the
# second always finds the first one's entries. The release becomes Latest only once its feed lists
# every platform below (scripts/release-make-latest.sh).
set -euo pipefail

# Every platform a stable release's feed lists: the keys the updater looks up, `{os}-{arch}`.
platforms() {
  printf '%s\n' darwin-aarch64 darwin-x86_64 windows-x86_64
}
if [ "${1:-}" = --platforms ]; then
  platforms
  exit 0
fi

: "${RELEASE_TAG:?RELEASE_TAG must name the release}"
: "${VERSION:?VERSION must name the version the files are}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository}"
if [ "$#" -eq 0 ]; then
  echo "usage: release-update-feed.sh <platform>=<file> ..." >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/update-feed.XXXXXX")"
base="https://github.com/$GITHUB_REPOSITORY/releases/download/$RELEASE_TAG"

ours='{}'
for entry in "$@"; do
  platform="${entry%%=*}"
  file="${entry#*=}"
  if [ "$platform" = "$entry" ] || [ -z "$platform" ] || [ -z "$file" ]; then
    echo "::error::$entry is not <platform>=<file>."
    exit 1
  fi
  if ! platforms | grep -qxF "$platform"; then
    echo "::error::$platform is not a platform the update feed lists. Add it to scripts/release-update-feed.sh."
    exit 1
  fi
  if [ ! -s "$file" ] || [ ! -s "$file.sig" ]; then
    echo "::error::$file and its signature $file.sig must both be there to be listed for $platform."
    exit 1
  fi
  ours="$(jq -n \
    --argjson ours "$ours" \
    --arg platform "$platform" \
    --arg signature "$(cat "$file.sig")" \
    --arg url "$base/$(basename "$file")" \
    '$ours + { ($platform): { signature: $signature, url: $url } }')"
done

# What the other signing run wrote, when it has run. Assigned first: a failure inside a command's
# argument would not stop the script.
assets="$(gh release view "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" --json assets --jq '.assets[].name')"
theirs='{}'
if grep -qxF latest.json <<<"$assets"; then
  gh release download "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" --pattern latest.json --dir "$work" --clobber
  if ! jq -e '(.platforms // {}) | type == "object"' "$work/latest.json" > /dev/null 2>&1; then
    echo "::error::The latest.json on $RELEASE_TAG is not an update feed. Remove it from the release and sign again."
    exit 1
  fi
  if [ "$(jq -r '.version' "$work/latest.json")" = "$VERSION" ]; then
    theirs="$(jq '.platforms // {}' "$work/latest.json")"
  else
    echo "The latest.json on $RELEASE_TAG describes version $(jq -r '.version' "$work/latest.json"), not $VERSION, so none of its platforms are kept."
  fi
fi

# The notes are the changelog section a person wrote, the same ones the release carries.
notes="$(awk -v v="## ${VERSION%%-*}" '$0==v{f=1;next} /^## /{if(f)exit} f' "$root/CHANGELOG.md")"
jq -n \
  --arg version "$VERSION" \
  --arg notes "$notes" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson platforms "$(jq -n --argjson theirs "$theirs" --argjson ours "$ours" '$theirs + $ours')" \
  '{ version: $version, notes: $notes, pub_date: $pub_date, platforms: $platforms }' \
  > latest.json
cat latest.json

gh release upload "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" latest.json --clobber
missing=()
while IFS= read -r platform; do
  if ! jq -e --arg platform "$platform" '.platforms | has($platform)' latest.json > /dev/null; then
    missing+=("$platform")
  fi
done < <(platforms)
if [ "${#missing[@]}" -gt 0 ]; then
  echo "latest.json on $RELEASE_TAG lists $(jq -r '.platforms | keys | join(", ")' latest.json). The other signing run adds ${missing[*]}."
else
  echo "latest.json on $RELEASE_TAG lists every platform."
fi
