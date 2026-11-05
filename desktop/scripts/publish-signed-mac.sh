#!/usr/bin/env bash
# Attaches a signed Mac build to its release, and makes a stable release Latest once it is there.
#
# Run from the repository root by the `publish` job of desktop-macos-signing.yml, with both
# architectures' signed artifacts merged into $ARTIFACTS.
#
# Env:
#   RELEASE_TAG        the release to attach to, such as v0.3.0
#   MAKE_LATEST        `true` when publish-release.yml decided this release becomes Latest
#   GITHUB_REPOSITORY  and GH_TOKEN, for `gh`
#   ARTIFACTS          the signed artifacts (default `artifacts`)
#   FEED_RETRY_DELAY   seconds between reads of the update feed (default 15)
#
# A candidate or beta was built pinned to its own release (desktop/scripts/signed-build.ts), with
# no updater, so only its .dmg files are attached: it has no updater archive and no latest.json,
# and it never becomes Latest.
#
# A stable release is published not Latest. It becomes Latest once both signing runs have
# attached their installers, here or in Desktop Windows signing, whichever finishes second
# (scripts/release-make-latest.sh). So `releases/latest` never serves an ad-hoc build that macOS
# refuses, an unsigned Windows installer, or a release with no Intel installer. Only when
# publish-release.yml said it should, and only when no newer release has become Latest since.
#
# Every .dmg is attached twice, in one upload: under the name Tauri gave it, replacing the ad-hoc
# one, and under its fixed download name (scripts/release-download-names.sh), so the address a web
# page links to serves the signed build too. Both happen before the release can become Latest.
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG must name the release}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository}"
artifacts="${ARTIFACTS:-artifacts}"
make_latest="${MAKE_LATEST:-false}"
delay="${FEED_RETRY_DELAY:-15}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

version="$(jq -r .version "$artifacts/build-version.json")"
if [ "$version" != "${RELEASE_TAG#v}" ]; then
  echo "::error::The signed build is version $version, not ${RELEASE_TAG#v}. Sign the release from its tag."
  exit 1
fi
pinned="$(jq -r '.pinned // empty' "$artifacts/build-version.json")"
gh release view "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" > /dev/null

images=()
while IFS= read -r image; do
  images+=("$image")
done < <(find "$artifacts" -maxdepth 1 -type f -name '*.dmg' | sort)
if [ "${#images[@]}" -eq 0 ]; then
  echo "::error::No signed .dmg in $artifacts."
  exit 1
fi
fixed_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/download-names.XXXXXX")"
uploads=("${images[@]}")
for image in "${images[@]}"; do
  # Assigned first: a failure inside a command's argument would not stop the script.
  fixed="$("$root/scripts/release-download-names.sh" "$image")"
  if [ -e "$fixed_dir/$fixed" ]; then
    echo "::error::Two signed images would both be published as $fixed."
    exit 1
  fi
  cp "$image" "$fixed_dir/$fixed"
  uploads+=("$fixed_dir/$fixed")
done

if [ -n "$pinned" ]; then
  if [ "$pinned" != "$RELEASE_TAG" ]; then
    echo "::error::The signed build is pinned to $pinned, not to $RELEASE_TAG."
    exit 1
  fi
  gh release upload "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" "${uploads[@]}" --clobber
  echo "Attached the signed installers of $RELEASE_TAG, pinned to its own images. A pinned build has no update feed and never becomes Latest."
  exit 0
fi

# latest.json names a version, and for each architecture the archive URL and the minisign
# signature of the archive at that URL. It is written from both architectures' real `.sig` files.
base="https://github.com/$GITHUB_REPOSITORY/releases/download/$RELEASE_TAG"
platforms='{}'
for target in darwin-aarch64 darwin-x86_64; do
  archive="$artifacts/OpenBot-$target.app.tar.gz"
  test -f "$archive"
  test -f "$archive.sig"
  platforms="$(jq -n \
    --argjson platforms "$platforms" \
    --arg target "$target" \
    --arg signature "$(cat "$archive.sig")" \
    --arg url "$base/OpenBot-$target.app.tar.gz" \
    '$platforms + { ($target): { signature: $signature, url: $url } }')"
done
# The notes are the changelog section a person wrote, the same ones the release carries.
notes="$(awk -v v="## ${version%%-*}" '$0==v{f=1;next} /^## /{if(f)exit} f' "$root/CHANGELOG.md")"
jq -n \
  --arg version "$version" \
  --arg notes "$notes" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson platforms "$platforms" \
  '{ version: $version, notes: $notes, pub_date: $pub_date, platforms: $platforms }' \
  > latest.json
cat latest.json

gh release upload "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" latest.json --clobber
gh release upload "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" "${uploads[@]}" --clobber
gh release upload "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" \
  "$artifacts/OpenBot-darwin-aarch64.app.tar.gz" \
  "$artifacts/OpenBot-darwin-aarch64.app.tar.gz.sig" \
  "$artifacts/OpenBot-darwin-x86_64.app.tar.gz" \
  "$artifacts/OpenBot-darwin-x86_64.app.tar.gz.sig" --clobber

# Latest once Windows signing has attached its installer too, and the feed check when it is.
MAKE_LATEST="$make_latest" FEED_RETRY_DELAY="$delay" "$root/scripts/release-make-latest.sh"
