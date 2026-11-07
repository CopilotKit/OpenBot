#!/usr/bin/env bash
# Makes a stable release Latest once every installer on it is signed, then checks the update feed
# the apps read when the release is Latest.
#
# Run from the repository root by the attach job of Desktop macOS signing and of Desktop Windows
# signing, after each has attached its signed installers. Whichever of the two finishes second
# makes the release Latest, so `releases/latest/download/<fixed name>` never serves an unsigned
# installer: until then it keeps serving the previous release's signed ones.
#
# Env:
#   RELEASE_TAG        the release, such as v0.3.0
#   MAKE_LATEST        `true` when publish-release.yml decided this release becomes Latest
#   GITHUB_REPOSITORY  and GH_TOKEN, for `gh`
#   FEED_RETRY_DELAY   seconds between reads of the update feed (default 15)
#
# A stable release is signed when it carries every fixed download name and a latest.json that lists
# every platform (scripts/release-update-feed.sh --platforms). On a stable release only the signing
# runs attach those: publish-release.yml attaches the unsigned installers under their versioned
# names alone (scripts/release-attach-installers.sh). Mac signing attaches both Mac names and lists
# both Mac archives in latest.json, and Windows signing attaches the Windows name and lists the
# Windows installer there. So a release never becomes Latest with a feed that leaves a platform
# behind: an app on it would never be offered the release, or any after it.
#
# Only when publish-release.yml said the release becomes Latest, and only when no newer release has
# become Latest since (scripts/release-becomes-latest.sh). Making it Latest also starts Downloads
# sync, so downloads.copilotkit.ai serves the same signed installers; the job needs `actions: write`.
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG must name the release}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository}"
make_latest="${MAKE_LATEST:-false}"
delay="${FEED_RETRY_DELAY:-15}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Whether a feed is for `version` and lists `platform` with a URL and a signature.
lists() {
  jq -e --arg version "$2" --arg platform "$3" '
    .version == $version and
    ((.platforms // {})[$platform] | (.url | type) == "string" and (.url | length) > 0
      and (.signature | type) == "string" and (.signature | length) > 0)
  ' "$1" > /dev/null 2>&1
}

latest_tag() {
  local out
  if out="$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name 2>&1)"; then
    printf '%s\n' "$out"
  elif grep -q 'HTTP 404' <<<"$out"; then
    printf '\n'
  else
    echo "::error::Could not read the current latest release: $out" >&2
    return 1
  fi
}

if [ "$make_latest" = true ]; then
  # Assigned first: a failure inside a command's argument would not stop the script.
  attached="$(gh release view "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" --json assets --jq '.assets[].name')"
  required="$("$root/scripts/release-download-names.sh" --all)"
  missing=()
  while IFS= read -r name; do
    if ! grep -qxF "$name" <<<"$attached"; then
      missing+=("$name")
    fi
  done < <(printf '%s\n%s\n' latest.json "$required")
  if [ "${#missing[@]}" -eq 0 ]; then
    feed="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/release-feed.XXXXXX")"
    gh release download "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" --pattern latest.json --dir "$feed" --clobber
    while IFS= read -r platform; do
      if ! lists "$feed/latest.json" "${RELEASE_TAG#v}" "$platform"; then
        missing+=("$platform in latest.json")
      fi
    done < <("$root/scripts/release-update-feed.sh" --platforms)
  fi
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "$RELEASE_TAG is not Latest yet: it still needs the signed ${missing[*]}. The signing run that attaches the last of them makes it Latest."
  else
    becomes="$(VERSION="$RELEASE_TAG" PRERELEASE=false "$root/scripts/release-becomes-latest.sh")"
    if [ "$becomes" = true ]; then
      gh release edit "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" --latest
      echo "$RELEASE_TAG is now the latest release."
      # downloads.copilotkit.ai mirrors the Latest release (scripts/downloads-sync.sh). An edit made
      # with the workflow's token starts no workflow, and a dispatch does, so the sync is started
      # here rather than by the release changing. It also runs every six hours in case this fails.
      gh workflow run downloads-sync.yml -R "$GITHUB_REPOSITORY" --ref main
      echo "Started Downloads sync, which copies its signed installers to downloads.copilotkit.ai."
    else
      echo "A newer release is already Latest, so $RELEASE_TAG stays as it is."
    fi
  fi
fi

# Installed apps read only the Latest release's feed. A release that is not Latest, such as one
# still waiting for a signing run, a patch to an older line or a release signed again by hand, has
# nothing here to check.
current="$(latest_tag)"
if [ "$current" != "$RELEASE_TAG" ]; then
  echo "$RELEASE_TAG is not the latest release, so installed apps do not read its feed. Not checking it."
  exit 0
fi

# Read back what installed apps will read: the release's own feed, compiled into them, fetched the
# way they fetch it, redirects and all. An endpoint that answers with a web page, or a Latest release
# that is not this one, fails here instead of failing silently in every app. The apps ask
# downloads.copilotkit.ai first, which Downloads sync (started above) fills with a checked copy of
# this same file a few minutes later, and fall back to this one when it does not answer.
endpoint="$(jq -r '[.plugins.updater.endpoints[] | select(startswith("https://github.com/"))][0]' \
  "$root/desktop/src-tauri/tauri.macos-signing.conf.json")"
expected="${RELEASE_TAG#v}"
for attempt in 1 2 3 4 5; do
  # The asset may have been uploaded seconds ago; give the download redirect a moment to catch up.
  if curl -fsSL --retry 3 "$endpoint" -o feed.json; then
    unlisted=()
    while IFS= read -r platform; do
      if ! lists feed.json "$expected" "$platform"; then
        unlisted+=("$platform")
      fi
    done < <("$root/scripts/release-update-feed.sh" --platforms)
    if [ "${#unlisted[@]}" -eq 0 ]; then
      echo "$endpoint serves latest.json for $expected, for every platform."
      exit 0
    fi
  fi
  if [ "$attempt" -lt 5 ]; then sleep "$delay"; fi
done
echo "::error::$endpoint does not serve a latest.json with version $expected and a signed file for every platform ($("$root/scripts/release-update-feed.sh" --platforms | paste -sd ' ' -))."
head -c 500 feed.json 2>/dev/null || true
exit 1
