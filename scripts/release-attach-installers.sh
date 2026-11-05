#!/usr/bin/env bash
# Attaches the installers the desktop job built to a release.
#
# Usage: release-attach-installers.sh <version> <installers folder>
# Env: OPENBOT_PUBLISHED_ASSETS, the folder an earlier attempt's assets were downloaded into, when
# the release already existed. GH_TOKEN, for `gh`.
#
# Every .dmg and .exe under the folder is attached. A release without them is not the release that
# was asked for, so finding none is a failure.
#
# What is already published wins. Desktop macOS signing replaces the ad-hoc .dmg with a signed one
# under the same name, and a re-run of the publish workflow must not put the ad-hoc build back over
# it. So an installer an earlier attempt or a signing run attached is kept. One that is missing,
# including one a failed upload left unreadable, is uploaded, and `--clobber` replaces whatever that
# failed upload left behind.
set -euo pipefail

version="${1:?usage: release-attach-installers.sh <version> <installers folder>}"
folder="${2:?usage: release-attach-installers.sh <version> <installers folder>}"
published="${OPENBOT_PUBLISHED_ASSETS:-}"

installers=()
while IFS= read -r installer; do
  installers+=("$installer")
done < <(find "$folder" -type f \( -name '*.dmg' -o -name '*.exe' \) | sort)
if [ "${#installers[@]}" -eq 0 ]; then
  echo "::error::No .dmg or .exe was found in $folder, so there is nothing to attach."
  exit 1
fi

for installer in "${installers[@]}"; do
  name="$(basename "$installer")"
  if [ -n "$published" ] && [ -f "$published/$name" ]; then
    echo "$name is already published; keeping it."
  else
    gh release upload "$version" "$installer" --clobber
    echo "Attached $name."
  fi
done
