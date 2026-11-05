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
# A stable release is published not Latest. It becomes Latest here, after its signed .dmg files
# are attached, so `releases/latest` never serves an ad-hoc build that macOS refuses, or a release
# with no Intel installer. Only when publish-release.yml said it should, and only when no newer
# release has become Latest since.
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

if [ -n "$pinned" ]; then
  if [ "$pinned" != "$RELEASE_TAG" ]; then
    echo "::error::The signed build is pinned to $pinned, not to $RELEASE_TAG."
    exit 1
  fi
  gh release upload "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" "${images[@]}" --clobber
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
gh release upload "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" "${images[@]}" --clobber
gh release upload "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" \
  "$artifacts/OpenBot-darwin-aarch64.app.tar.gz" \
  "$artifacts/OpenBot-darwin-aarch64.app.tar.gz.sig" \
  "$artifacts/OpenBot-darwin-x86_64.app.tar.gz" \
  "$artifacts/OpenBot-darwin-x86_64.app.tar.gz.sig" --clobber

if [ "$make_latest" = true ]; then
  becomes="$(VERSION="$RELEASE_TAG" PRERELEASE=false "$root/scripts/release-becomes-latest.sh")"
  if [ "$becomes" = true ]; then
    gh release edit "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" --latest
    echo "$RELEASE_TAG is now the latest release."
  else
    echo "A newer release is already Latest, so $RELEASE_TAG stays as it is."
  fi
fi

# Installed apps read only the Latest release's feed. A release that is not Latest, such as a patch
# to an older line or a release signed again by hand, has nothing here to check.
if out="$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name 2>&1)"; then
  current="$out"
elif grep -q 'HTTP 404' <<<"$out"; then
  current=""
else
  echo "::error::Could not read the current latest release: $out"
  exit 1
fi
if [ "$current" != "$RELEASE_TAG" ]; then
  echo "$RELEASE_TAG is not the latest release, so installed apps do not read its feed. Not checking it."
  exit 0
fi

# Read back what installed apps will read: the endpoint compiled into them, fetched the way they
# fetch it, redirects and all. An endpoint that answers with a web page, or a Latest release that is
# not this one, fails here instead of failing silently in every app.
endpoint="$(jq -r '.plugins.updater.endpoints[0]' "$root/desktop/src-tauri/tauri.macos-signing.conf.json")"
expected="${RELEASE_TAG#v}"
for attempt in 1 2 3 4 5; do
  # The asset was uploaded seconds ago; give the download redirect a moment to catch up.
  if curl -fsSL --retry 3 "$endpoint" -o feed.json &&
    jq -e --arg version "$expected" '
      .version == $version and
      ([.platforms // {} | to_entries[]
        | select(.key | startswith("darwin-"))
        | select((.value.url | type) == "string" and (.value.signature | type) == "string")]
        | length > 0)
    ' feed.json > /dev/null 2>&1; then
    echo "$endpoint serves latest.json for $expected."
    exit 0
  fi
  if [ "$attempt" -lt 5 ]; then sleep "$delay"; fi
done
echo "::error::$endpoint does not serve a latest.json with version $expected and a darwin-* platform."
head -c 500 feed.json 2>/dev/null || true
exit 1
