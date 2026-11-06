#!/usr/bin/env bash
# Attaches a signed Windows installer to its release.
#
# Run from the repository root by the `publish` job of desktop-signing.yml, with the signing job's
# artifact downloaded into $ARTIFACTS.
#
# Env:
#   RELEASE_TAG        the release to attach to, such as v0.3.0
#   MAKE_LATEST        `true` when publish-release.yml decided this release becomes Latest
#   GITHUB_REPOSITORY  and GH_TOKEN, for `gh`
#   ARTIFACTS          the signed artifact (default `artifacts`)
#   FEED_RETRY_DELAY   seconds between reads of the update feed (default 15)
#
# The signed -setup.exe is attached twice, in one upload, with `--clobber`: under the name Tauri gave
# it, replacing the unsigned installer the release was published with, and under its fixed download
# name (scripts/release-download-names.sh), so the address a web page links to serves the signed
# build too. A candidate or beta was built pinned to its own release
# (desktop/scripts/signed-build.ts), like the unsigned one it replaces, and never becomes Latest.
#
# A stable release becomes Latest once both signing runs have attached their installers, here or
# in Desktop macOS signing, whichever finishes second (scripts/release-make-latest.sh). So the
# Windows address a web page links to never serves the unsigned installer.
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG must name the release}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository}"
artifacts="${ARTIFACTS:-artifacts}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The signed build must be the tag's own build. A run from a branch is an internal build, named
# after its commit, and would fail here.
version="$(jq -r .version "$artifacts/build-version.json")"
if [ "$version" != "${RELEASE_TAG#v}" ]; then
  echo "::error::The signed installer is version $version, not ${RELEASE_TAG#v}. Sign the release from its tag."
  exit 1
fi
pinned="$(jq -r '.pinned // empty' "$artifacts/build-version.json")"
if [ -n "$pinned" ] && [ "$pinned" != "$RELEASE_TAG" ]; then
  echo "::error::The signed installer is pinned to $pinned, not to $RELEASE_TAG."
  exit 1
fi
gh release view "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" > /dev/null

installers=()
while IFS= read -r installer; do
  installers+=("$installer")
done < <(find "$artifacts" -type f -name '*-setup.exe' | sort)
if [ "${#installers[@]}" -ne 1 ]; then
  echo "::error::Expected one signed -setup.exe in $artifacts, found ${#installers[@]}."
  exit 1
fi
installer="${installers[0]}"
fixed="$("$root/scripts/release-download-names.sh" "$installer")"
fixed_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/download-names.XXXXXX")"
cp "$installer" "$fixed_dir/$fixed"

gh release upload "$RELEASE_TAG" -R "$GITHUB_REPOSITORY" "$installer" "$fixed_dir/$fixed" --clobber
echo "Attached the signed $(basename "$installer") to $RELEASE_TAG, also as $fixed."
if [ -n "$pinned" ]; then
  echo "It is pinned to the images of $RELEASE_TAG."
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Signed Windows installer attached to $RELEASE_TAG"
    echo ""
    echo "- \`$(basename "$installer")\`, also as \`$fixed\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ -z "$pinned" ]; then
  MAKE_LATEST="${MAKE_LATEST:-false}" "$root/scripts/release-make-latest.sh"
fi
