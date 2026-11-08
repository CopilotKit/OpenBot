#!/usr/bin/env bash
# Put the NSIS toolset where `tauri build` looks for it, so bundling the Windows installer never
# downloads it.
#
# The first time Tauri bundles NSIS on a machine it fetches NSIS and its nsis_tauri_utils plugin
# from GitHub release downloads, once, with no retry (tauri-bundler's `http_utils::download`). On
# 2026-11-08 github.com answered that request with a 504 and the Windows build died with "failed to
# bundle project: http status: 504", leaving no installer. Tauri skips the download when
# <tools>/NSIS already holds every file it checks for and the plugin matches its pinned hash
# (`bundle/windows/nsis/mod.rs`), so this fetches the same files, retrying 5xx and connection
# errors, falls back to the REST API's release-asset endpoint when github.com's download page stays
# down, checks each against its sha256, and lays them out exactly as Tauri would.
#
# The pins are tauri-bundler 2.9.4's, the bundler inside @tauri-apps/cli 2.11.4. The regression
# test checks that desktop/bun.lock still locks that CLI, so a CLI bump fails there until the pins
# are read again from the new bundler. If a stale plugin pin did get through, Tauri would find the
# wrong hash and download its own plugin: a stale pin loses the retries, never the build.
#
# Usage: prefetch-nsis.sh [tools directory]
# The directory defaults to %LOCALAPPDATA%\tauri, which is Tauri's own (`dirs::cache_dir()` joined
# with `tauri`). PREFETCH_NSIS_GITHUB, PREFETCH_NSIS_API, PREFETCH_NSIS_RETRIES and the two
# *_SHA256 overrides exist so the regression test (prefetch-nsis.test.ts) can stand in for GitHub.
set -euo pipefail

TAURI_CLI_VERSION="2.11.4"

nsis_repo=tauri-apps/binary-releases
nsis_tag="nsis-3.11"
nsis_asset="nsis-3.11.zip"
nsis_asset_id=317051073
nsis_sha256="${PREFETCH_NSIS_ZIP_SHA256:-c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1}"
# The directory the zip unpacks to, which Tauri renames to NSIS.
nsis_root="nsis-3.11"

plugin_repo=tauri-apps/nsis-tauri-utils
plugin_tag="nsis_tauri_utils-v0.5.3"
plugin_asset="nsis_tauri_utils.dll"
plugin_asset_id=345882097
plugin_sha256="${PREFETCH_NSIS_PLUGIN_SHA256:-5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709}"
plugin_path=Plugins/x86-unicode/additional/nsis_tauri_utils.dll

# Tauri's NSIS_REQUIRED_FILES. Any one missing and Tauri deletes the directory and downloads again.
required=(
  makensis.exe
  Bin/makensis.exe
  Stubs/lzma-x86-unicode
  Stubs/lzma_solid-x86-unicode
  "$plugin_path"
  Include/MUI2.nsh
  Include/FileFunc.nsh
  Include/x64.nsh
  Include/nsDialogs.nsh
  Include/WinMessages.nsh
  Include/Win/COM.nsh
  Include/Win/Propkey.nsh
  Include/Win/RestartManager.nsh
)

github="${PREFETCH_NSIS_GITHUB:-https://github.com}"
api="${PREFETCH_NSIS_API:-https://api.github.com}"
retries="${PREFETCH_NSIS_RETRIES:-5}"

tools="${1:-}"
if [ -z "$tools" ]; then
  : "${LOCALAPPDATA:?LOCALAPPDATA is not set; pass the tools directory instead.}"
  tools="$LOCALAPPDATA"
  if command -v cygpath > /dev/null; then tools="$(cygpath -u "$tools")"; fi
  tools="$tools/tauri"
fi
nsis="$tools/NSIS"

sha256() {
  if command -v sha256sum > /dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

complete() {
  local file
  for file in "${required[@]}"; do
    [ -f "$nsis/$file" ] || return 1
  done
  [ "$(sha256 "$nsis/$plugin_path")" = "$plugin_sha256" ]
}

# fetch <repo> <tag> <asset> <asset id> <sha256> <output>
fetch() {
  local repo="$1" tag="$2" asset="$3" id="$4" want="$5" out="$6" got
  if ! curl -fsSL --retry "$retries" --retry-all-errors -o "$out" \
    "$github/$repo/releases/download/$tag/$asset"; then
    echo "::warning::github.com did not serve $asset; fetching it through the REST API instead."
    curl -fsSL --retry "$retries" --retry-all-errors -H 'Accept: application/octet-stream' \
      -o "$out" "$api/repos/$repo/releases/assets/$id"
  fi
  got="$(sha256 "$out")"
  if [ "$got" != "$want" ]; then
    echo "::error::$asset has sha256 $got, expected $want."
    return 1
  fi
}

if complete; then
  echo "NSIS is already in $nsis."
  exit 0
fi

mkdir -p "$tools"
# Unpacked beside its destination and moved in whole, so a failure never leaves a half-made NSIS
# directory for Tauri to find.
work="$(mktemp -d "$tools/.prefetch-nsis.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fetch "$nsis_repo" "$nsis_tag" "$nsis_asset" "$nsis_asset_id" "$nsis_sha256" "$work/$nsis_asset"
fetch "$plugin_repo" "$plugin_tag" "$plugin_asset" "$plugin_asset_id" "$plugin_sha256" \
  "$work/$plugin_asset"

unzip -q "$work/$nsis_asset" -d "$work"
mkdir -p "$(dirname "$work/$nsis_root/$plugin_path")"
mv "$work/$plugin_asset" "$work/$nsis_root/$plugin_path"
rm -rf "$nsis"
mv "$work/$nsis_root" "$nsis"

if ! complete; then
  echo "::error::$nsis_asset did not unpack to the files Tauri checks for."
  exit 1
fi
echo "NSIS from $nsis_asset, pinned for Tauri CLI $TAURI_CLI_VERSION, is in $nsis; tauri build will not download it."
