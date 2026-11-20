#!/usr/bin/env bash
# Put the tools `tauri build` downloads where it looks for them, so bundling never downloads them.
#
# The first time Tauri bundles on a machine it fetches its tools from GitHub, once each, with no
# retry (tauri-bundler's `http_utils::download`): NSIS and the nsis_tauri_utils plugin on Windows,
# AppRun, linuxdeploy and two linuxdeploy plugins for the Linux AppImage. On 2026-11-08 github.com
# answered every download from tauri-apps/binary-releases with a 504, and the desktop builds died
# with "failed to bundle project: http status: 504". Tauri skips a download when the file is already
# in its tools directory (`bundle/windows/nsis/mod.rs`, `bundle/linux/appimage/linuxdeploy.rs`), so
# this fetches the same files first and puts them there.
#
# Release assets come through the REST API's release-asset endpoint, which was answering while
# github.com's download page was not, authenticated with GH_TOKEN when it is set, and from the
# github.com download URL if the API fails. Each request goes through download.sh, which retries
# 5xx, connection errors and a download that stalls, the way the app downloads. Every
# file is checked against a pinned sha256 before it is put in place, and a mismatch fails at once
# rather than trying the next source.
#
# The pins are tauri-bundler 2.9.4's, the bundler inside @tauri-apps/cli 2.11.4. The regression
# test checks that desktop/bun.lock still locks that CLI, so a CLI bump fails there until the pins
# are read again from the new bundler. The linuxdeploy plugins are scripts Tauri reads from each
# repository's master branch; they are pinned here to the commit master was at when this was
# written, which is the same bytes.
#
# Not fetched: linuxdeploy-plugin-appimage, from a release that is rebuilt in place ("continuous"),
# so it cannot be pinned. Tauri treats that download as optional and falls back to linuxdeploy's
# built-in copy when it fails.
#
# Usage: prefetch-tauri-tools.sh windows|linux [tools directory]
# The directory defaults to Tauri's own, `dirs::cache_dir()` joined with `tauri`: %LOCALAPPDATA%\tauri
# on Windows, ${XDG_CACHE_HOME:-~/.cache}/tauri on Linux. PREFETCH_TAURI_API, PREFETCH_TAURI_GITHUB,
# PREFETCH_TAURI_RAW, PREFETCH_TAURI_RETRIES, PREFETCH_TAURI_ARCH and the *_SHA256 overrides exist so the regression test
# (prefetch-tauri-tools.test.ts) can stand in for GitHub.
set -euo pipefail

TAURI_CLI_VERSION="2.11.4"

platform="${1:?usage: prefetch-tauri-tools.sh windows|linux [tools directory]}"
tools="${2:-}"

api="${PREFETCH_TAURI_API:-https://api.github.com}"
github="${PREFETCH_TAURI_GITHUB:-https://github.com}"
raw="${PREFETCH_TAURI_RAW:-https://raw.githubusercontent.com}"
DOWNLOAD_RETRIES="${PREFETCH_TAURI_RETRIES:-${DOWNLOAD_RETRIES:-5}}"
# shellcheck source-path=SCRIPTDIR source=download.sh
source "$(dirname "${BASH_SOURCE[0]}")/download.sh"

# Sent to the API only. curl does not carry a custom Authorization header to another host when it
# follows the API's redirect to the file itself.
auth=()
if [ -n "${GH_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GH_TOKEN"); fi

sha256() {
  if command -v sha256sum > /dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# get <sha256> <output> <source>... where a source is a URL, or `api:<url>` for a release asset or
# `contents:<url>` for a repository file, both through the REST API.
get() {
  local want="$1" out="$2" source url got
  shift 2
  for source in "$@"; do
    local headers=()
    case "$source" in
      api:*)
        url="${source#api:}"
        headers=(-H 'Accept: application/octet-stream' ${auth[@]+"${auth[@]}"})
        ;;
      contents:*)
        url="${source#contents:}"
        headers=(-H 'Accept: application/vnd.github.raw' ${auth[@]+"${auth[@]}"})
        ;;
      *) url="$source" ;;
    esac
    if download ${headers[@]+"${headers[@]}"} -o "$out" "$url"; then
      got="$(sha256 "$out")"
      if [ "$got" = "$want" ]; then return 0; fi
      echo "::error::$url served a file with sha256 $got, expected $want."
      return 1
    fi
    echo "::warning::Could not fetch $url; trying the next source."
  done
  echo "::error::No source served $(basename "$out")."
  return 1
}

# release_asset <repo> <tag> <asset> <asset id> <sha256> <output>
release_asset() {
  get "$5" "$6" "api:$api/repos/$1/releases/assets/$4" "$github/$1/releases/download/$2/$3"
}

# repo_file <repo> <commit> <path> <sha256> <output>
repo_file() {
  get "$4" "$5" "$raw/$1/$2/$3" "contents:$api/repos/$1/contents/$3?ref=$2"
}

windows() {
  if [ -z "$tools" ]; then
    : "${LOCALAPPDATA:?LOCALAPPDATA is not set; pass the tools directory instead.}"
    tools="$LOCALAPPDATA"
    if command -v cygpath > /dev/null; then tools="$(cygpath -u "$tools")"; fi
    tools="$tools/tauri"
  fi
  local nsis="$tools/NSIS"
  local nsis_sha256="${NSIS_ZIP_SHA256:-c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1}"
  local plugin_sha256="${NSIS_PLUGIN_SHA256:-5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709}"
  local plugin_path="Plugins/x86-unicode/additional/nsis_tauri_utils.dll"
  # Tauri's NSIS_REQUIRED_FILES. Any one missing and Tauri deletes the directory and downloads
  # again, and a plugin with the wrong hash it downloads again by itself.
  local required=(
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
  complete() {
    local file
    for file in "${required[@]}"; do
      [ -f "$nsis/$file" ] || return 1
    done
    [ "$(sha256 "$nsis/$plugin_path")" = "$plugin_sha256" ]
  }

  if complete; then
    echo "NSIS is already in $nsis."
    return 0
  fi
  mkdir -p "$tools"
  # Unpacked beside its destination and moved in whole, so a failure never leaves a half-made NSIS
  # directory for Tauri to find.
  work="$(mktemp -d "$tools/.prefetch.XXXXXX")"
  release_asset tauri-apps/binary-releases nsis-3.11 nsis-3.11.zip 317051073 \
    "$nsis_sha256" "$work/nsis-3.11.zip"
  release_asset tauri-apps/nsis-tauri-utils nsis_tauri_utils-v0.5.3 nsis_tauri_utils.dll \
    345882097 "$plugin_sha256" "$work/nsis_tauri_utils.dll"
  # The zip unpacks to nsis-3.11/, which Tauri renames to NSIS.
  unzip -q "$work/nsis-3.11.zip" -d "$work"
  mkdir -p "$(dirname "$work/nsis-3.11/$plugin_path")"
  mv "$work/nsis_tauri_utils.dll" "$work/nsis-3.11/$plugin_path"
  rm -rf "$nsis"
  mv "$work/nsis-3.11" "$nsis"
  if ! complete; then
    echo "::error::nsis-3.11.zip did not unpack to the files Tauri checks for."
    return 1
  fi
  echo "NSIS for Tauri CLI $TAURI_CLI_VERSION is in $nsis; tauri build will not download it."
}

linux() {
  if [ -z "$tools" ]; then
    tools="${XDG_CACHE_HOME:-${HOME:?HOME is not set}/.cache}/tauri"
  fi
  local arch="${PREFETCH_TAURI_ARCH:-$(uname -m)}"
  if [ "$arch" != x86_64 ]; then
    echo "::warning::Tools are pinned for x86_64 only, not $arch; tauri build will download its own."
    return 0
  fi
  mkdir -p "$tools"
  work="$(mktemp -d "$tools/.prefetch.XXXXXX")"
  # name, then how to fetch it. Tauri checks only that each file exists, and writes linuxdeploy's
  # header after every run, so an existing file is left alone rather than checked again.
  local fetched=0
  place() {
    local name="$1"
    shift
    if [ -e "$tools/$name" ]; then return 0; fi
    "$@" "$work/$name"
    chmod 755 "$work/$name"
    mv "$work/$name" "$tools/$name"
    fetched=$((fetched + 1))
  }
  place AppRun-x86_64 release_asset tauri-apps/binary-releases apprun-old AppRun-x86_64 \
    274691722 "${APPRUN_SHA256:-f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f}"
  place linuxdeploy-x86_64.AppImage release_asset tauri-apps/binary-releases linuxdeploy \
    linuxdeploy-x86_64.AppImage 182515537 \
    "${LINUXDEPLOY_SHA256:-e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef}"
  place linuxdeploy-plugin-gtk.sh repo_file tauri-apps/linuxdeploy-plugin-gtk \
    dda522bce37387f1b853d9095713bfaa924c8423 linuxdeploy-plugin-gtk.sh \
    "${GTK_PLUGIN_SHA256:-7804c9eef13e59bf2783aad9882ef9db8f3f3f9e8d631874b1d348d550a3693f}"
  place linuxdeploy-plugin-gstreamer.sh repo_file tauri-apps/linuxdeploy-plugin-gstreamer \
    2a2e67491c32995a3f279ad0ecbe77abd512b42a linuxdeploy-plugin-gstreamer.sh \
    "${GSTREAMER_PLUGIN_SHA256:-c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94}"
  echo "Fetched $fetched AppImage tools for Tauri CLI $TAURI_CLI_VERSION into $tools; tauri build will not download them."
}

work=""
trap 'if [ -n "$work" ]; then rm -rf "$work"; fi' EXIT
case "$platform" in
  windows) windows ;;
  linux) linux ;;
  *)
    echo "::error::platform must be windows or linux, got '$platform'."
    exit 1
    ;;
esac
