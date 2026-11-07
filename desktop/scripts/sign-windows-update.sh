#!/usr/bin/env bash
# Signs the Windows installer for the in-app updater, and checks the signature against the public
# key the Windows app is built with.
#
# Run from the repository root by the `sign-update` job of desktop-signing.yml, with the signing
# job's artifact downloaded into $ARTIFACTS. It writes `<installer>.sig` beside the installer.
#
# Env:
#   ARTIFACTS                           the signing job's artifact (default `artifacts`)
#   TAURI_SIGNING_PRIVATE_KEY           the Tauri updater private key, and
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password: the same pair Desktop macOS signing signs with
#   TAURI                               the Tauri CLI (default desktop/node_modules/.bin/tauri)
#   OVERLAY                             where the public key is read (default the Windows signing
#                                       overlay)
#
# On Windows the updater installs the NSIS installer itself, so the file it downloads and the file a
# person downloads are one and the same: the -setup.exe the signing job built, Authenticode-signed
# and verified. This signs exactly those bytes, after Authenticode signing, so the minisign signature
# covers the installer people run. It is the same signature `tauri build` writes beside an updater
# artifact (`tauri signer sign`, the same CLI), made here because the updater key lives in the
# `macos-signing` environment and the Windows build runs in `windows-signing`.
#
# Then minisign, the reference implementation of the format, verifies it against
# `plugins.updater.pubkey`, so a key that does not match the app fails here rather than in every
# installed app.
set -euo pipefail

: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY must hold the updater key}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifacts="${ARTIFACTS:-artifacts}"
tauri="${TAURI:-$root/desktop/node_modules/.bin/tauri}"
overlay="${OVERLAY:-$root/desktop/src-tauri/tauri.windows-signing.conf.json}"

if [ -n "$(jq -r '.pinned // empty' "$artifacts/build-version.json")" ]; then
  echo "::error::This build is pinned to a release, and a pinned build has no updater to sign for."
  exit 1
fi
installers=()
while IFS= read -r installer; do
  installers+=("$installer")
done < <(find "$artifacts" -type f -name '*-setup.exe' | sort)
if [ "${#installers[@]}" -ne 1 ]; then
  echo "::error::Expected one signed -setup.exe in $artifacts, found ${#installers[@]}."
  exit 1
fi
installer="${installers[0]}"

rm -f "$installer.sig"
"$tauri" signer sign "$installer" > /dev/null
test -s "$installer.sig"

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/update-signature.XXXXXX")"
jq -r '.plugins.updater.pubkey' "$overlay" | base64 -d > "$work/updater.pub"
base64 -d < "$installer.sig" > "$work/installer.minisig"
if ! minisign -V -q -p "$work/updater.pub" -m "$installer" -x "$work/installer.minisig"; then
  echo "::error::The updater signature of $(basename "$installer") does not verify against plugins.updater.pubkey in $(basename "$overlay"). Every installed app would refuse this update."
  exit 1
fi
echo "Signed $(basename "$installer") for the updater; the signature verifies against the app's public key."
echo "SHA-256 $(openssl dgst -sha256 -r "$installer" | cut -d' ' -f1)"
