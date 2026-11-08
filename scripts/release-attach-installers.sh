#!/usr/bin/env bash
# Attaches a candidate or beta's ad-hoc and unsigned installers to its release, where the release
# does not already have them.
#
# Usage: release-attach-installers.sh <version> <installers folder>
# Env: GH_TOKEN, for `gh`. ATTACHED_LIST, optional, see below.
#
# Every .dmg and .exe under the folder is attached. A release without them is not the release that
# was asked for, so finding none is a failure.
#
# This runs in publish-release.yml's `installers` job, after Desktop macOS signing and Desktop
# Windows signing have been started on the release, and a signing run may attach its signed build
# before, during or after it. So it never replaces anything. An installer is uploaded only when the
# release has no asset of that name, without `--clobber`, and when the upload fails because a
# signing run attached the name meanwhile, the signed one is kept. A signing run always replaces
# both of its names with `--clobber`, so whichever comes first, the signed build is what stays. A
# re-run of the publish workflow is the same: it adds what is missing and keeps everything else.
#
# Each installer is also attached under its fixed download name (release-download-names.sh), so a
# tester has a link before signing is approved. The copy is made from the installer as it is on the
# release: when a signed one is already there, the copy is the signed one too. A fixed name that is
# already on the release is kept as it is; the signing run that attached it replaces it again when
# it runs again.
#
# A stable release's installers are only ever the signing runs' own, attached under both names, and
# it becomes Latest once every fixed name is on it (release-make-latest.sh). So for a stable version
# this attaches no fixed name: an unsigned copy would be served from `releases/latest/download`.
#
# When ATTACHED_LIST names a file, writes "<installer name> <fixed name>" to it, one per line, for
# the run summary.
set -euo pipefail

version="${1:?usage: release-attach-installers.sh <version> <installers folder>}"
folder="${2:?usage: release-attach-installers.sh <version> <installers folder>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixed_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/download-names.XXXXXX")"
from_release="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/from-release.XXXXXX")"

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

# The names on the release now. Read again after a failed upload, to tell a name another run
# attached meanwhile from an upload that failed.
on_release=""
read_release() {
  on_release="$(gh release view "$version" --json assets --jq '.assets[].name')"
}
has() {
  grep -qxF "$1" <<<"$on_release"
}
# Uploads a file under its own name unless the release has that name. Prints `added` or `kept`.
add() {
  local file="$1" name
  name="$(basename "$file")"
  if has "$name"; then
    echo kept
  elif gh release upload "$version" "$file" >&2; then
    echo added
  else
    read_release
    if has "$name"; then
      echo "$name was attached by another run meanwhile; keeping that one." >&2
      echo kept
    else
      echo "::error::Could not attach $name to $version." >&2
      return 1
    fi
  fi
}

read_release
summary=()
for i in "${!installers[@]}"; do
  installer="${installers[$i]}"
  fixed="${fixed_names[$i]}"
  name="$(basename "$installer")"
  # Assigned first: a failure inside a command's argument would not stop the script.
  outcome="$(add "$installer")"
  if [ "$outcome" = kept ]; then
    echo "$name is already on the release; keeping it."
  else
    echo "Attached $name."
  fi
  if [[ "$version" != *-* ]]; then
    echo "$fixed is attached by the signing run, from the signed $name."
  elif has "$fixed"; then
    echo "$fixed is already on the release; keeping it."
  else
    if [ "$outcome" = kept ]; then
      # The installer as the release has it, which may be the signed one.
      gh release download "$version" --pattern "$name" --dir "$from_release" --clobber
      cp "$from_release/$name" "$fixed_dir/$fixed"
    else
      cp "$installer" "$fixed_dir/$fixed"
    fi
    copied="$(add "$fixed_dir/$fixed")"
    if [ "$copied" = added ]; then
      echo "Attached $name as $fixed."
    else
      echo "$fixed is already on the release; keeping it."
    fi
  fi
  summary+=("$name $fixed")
done
printf '%s\n' "${summary[@]}" > "${ATTACHED_LIST:-/dev/null}"
