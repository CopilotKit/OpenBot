#!/usr/bin/env bash
# Prints `true` when VERSION should be this repository's Latest release, and `false` otherwise.
#
# A candidate or beta never is. A stable release is when there is no Latest release yet, or when it
# sorts at or above the current one. A patch to an older line, or a re-run of an older release,
# must not move customer installers back.
#
# `publish-release.yml` asks this before anything is built, and Desktop macOS signing asks it again
# just before it marks the release Latest. A newer release may have been published between those
# two moments, and the second answer keeps Latest from going backwards.
#
# Only a 404 means there is no Latest release yet. A rate limit or a server error stops here:
# reading it as "no Latest" would hand Latest to an older release.
#
# Env: VERSION (`v1.2.3`), PRERELEASE (`true` or `false`), GITHUB_REPOSITORY, GH_TOKEN.
set -euo pipefail

: "${VERSION:?VERSION must name the release, such as v1.2.3}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository}"

if [ "${PRERELEASE:-false}" = true ]; then
  echo false
  exit 0
fi

if out="$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name 2>&1)"; then
  current="$out"
elif grep -q 'HTTP 404' <<<"$out"; then
  current=""
else
  echo "::error::Could not read the current latest release: $out" >&2
  exit 1
fi

highest="$(printf '%s\n%s\n' "${current#v}" "${VERSION#v}" | sort -V | tail -n 1)"
if [ -z "$current" ] || [ "$highest" = "${VERSION#v}" ]; then
  echo true
else
  echo false
fi
