#!/usr/bin/env bash
# Attaches the installers the desktop job built to a release.
#
# Usage: release-attach-installers.sh <version> <installers folder>
# Env: OPENBOT_PUBLISHED_ASSETS, the folder an earlier attempt's assets were downloaded into, when
# the release already existed. GH_TOKEN, for `gh`. ATTACHED_LIST, optional, see below.
#
# Every .dmg and .exe under the folder is attached. A release without them is not the release that
# was asked for, so finding none is a failure.
#
# What is already published wins. Desktop macOS signing and Desktop Windows signing replace the
# unsigned installers with signed ones under the same names, and a re-run of the publish workflow
# must not put the unsigned build back over them. So an installer an earlier attempt or a signing run attached is kept. One that is missing,
# including one a failed upload left unreadable, is uploaded, and `--clobber` replaces whatever that
# failed upload left behind.
#
# A candidate or beta's installers are also attached under their fixed download names
# (release-download-names.sh), so a tester has a link before signing is approved. The fixed-name
# copy is made from the installer as it is on the release: when the signed one was kept, the copy
# is the signed one too. A copy that is missing, or that differs from its installer, such as one an
# interrupted signing upload left behind, is replaced.
#
# A stable release's fixed names are left to the signing runs, which attach them from the signed
# installers. A web page links to `releases/latest/download/<fixed name>`, and the release becomes
# Latest only once every fixed name is on it (release-make-latest.sh), so those links never serve
# an unsigned installer.
#
# When ATTACHED_LIST names a file, writes "<installer name> <fixed name>" to it, one per line, for
# the run summary.
set -euo pipefail

version="${1:?usage: release-attach-installers.sh <version> <installers folder>}"
folder="${2:?usage: release-attach-installers.sh <version> <installers folder>}"
published="${OPENBOT_PUBLISHED_ASSETS:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixed_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/download-names.XXXXXX")"

installers=()
while IFS= read -r installer; do
  installers+=("$installer")
done < <(find "$folder" -type f \( -name '*.dmg' -o -name '*.exe' \) | sort)
if [ "${#installers[@]}" -eq 0 ]; then
  echo "::error::No .dmg or .exe was found in $folder, so there is nothing to attach."
  exit 1
fi

# Every fixed name first, so an unknown installer or two installers with one fixed name fail before
# anything is uploaded.
fixed_names=()
for installer in "${installers[@]}"; do
  fixed="$("$here/release-download-names.sh" "$installer")"
  for seen in "${fixed_names[@]+"${fixed_names[@]}"}"; do
    if [ "$seen" = "$fixed" ]; then
      echo "::error::Two installers in $folder would both be published as $fixed."
      exit 1
    fi
  done
  fixed_names+=("$fixed")
done

summary=()
for i in "${!installers[@]}"; do
  installer="${installers[$i]}"
  fixed="${fixed_names[$i]}"
  name="$(basename "$installer")"
  if [ -n "$published" ] && [ -f "$published/$name" ]; then
    echo "$name is already published; keeping it."
    attached="$published/$name"
  else
    gh release upload "$version" "$installer" --clobber
    echo "Attached $name."
    attached="$installer"
  fi
  if [[ "$version" != *-* ]]; then
    # A stable release: only the signing runs attach its fixed names, from the signed installers,
    # and it becomes Latest once all of them are there (release-make-latest.sh). An unsigned copy
    # here would be served from `releases/latest/download` the moment it did.
    echo "$fixed is attached by the signing run, from the signed $name."
  elif [ -n "$published" ] && [ -f "$published/$fixed" ] && cmp -s "$attached" "$published/$fixed"; then
    echo "$fixed is already a copy of $name."
  else
    cp "$attached" "$fixed_dir/$fixed"
    gh release upload "$version" "$fixed_dir/$fixed" --clobber
    echo "Attached $name as $fixed."
  fi
  summary+=("$name $fixed")
done
printf '%s\n' "${summary[@]}" > "${ATTACHED_LIST:-/dev/null}"
