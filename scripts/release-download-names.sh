#!/usr/bin/env bash
# Prints the fixed name a release attaches an installer under.
#
# Usage: release-download-names.sh <installer file>
#        release-download-names.sh --all      every fixed name, one per line
#        release-download-names.sh --retired  every fixed name no longer published, one per line
#
# Tauri puts the version in every installer's name, `OpenBot_0.3.0_aarch64.dmg`, so a link to
# `releases/latest/download/<that name>` breaks with the next release. Each installer is also
# attached under a name without the version, and a web page links to that one. These names are a
# public address: docs/releasing.md lists them, and changing one breaks every page that links to it.
#
# A file that is not one of the known installers fails, so a new platform or a renamed product is
# noticed instead of being published without a stable link. The Mac app ships for Apple silicon
# only, so an Intel .dmg (`OpenBot_0.3.0_x64.dmg`) is one of those.
set -euo pipefail

# Every fixed name. A stable release becomes Latest only once each of these is on it, signed
# (scripts/release-make-latest.sh), so a new one here is one more installer it waits for.
if [ "${1:-}" = --all ]; then
  printf '%s\n' OpenBot-mac-arm64.dmg OpenBot-windows-x64-setup.exe
  exit 0
fi

# Fixed names an earlier release published and no release publishes now. A name moves here when its
# platform stops shipping, rather than disappearing: GitHub stops serving it once the Latest release
# lacks it, and Downloads sync (scripts/downloads-sync.sh) removes its latest/ copy from
# downloads.copilotkit.ai at the same point, instead of serving the last build forever.
# OpenBot-mac-x64.dmg is the Intel Mac installer, last published in v0.3.0.
if [ "${1:-}" = --retired ]; then
  printf '%s\n' OpenBot-mac-x64.dmg
  exit 0
fi

name="$(basename "${1:?usage: release-download-names.sh <installer file>}")"
if [[ "$name" =~ ^OpenBot_[^_]+_aarch64\.dmg$ ]]; then
  echo OpenBot-mac-arm64.dmg
elif [[ "$name" =~ ^OpenBot_[^_]+_x64-setup\.exe$ ]]; then
  echo OpenBot-windows-x64-setup.exe
else
  echo "::error::$name is not an installer with a fixed download name. Add it to scripts/release-download-names.sh and docs/releasing.md." >&2
  exit 1
fi
