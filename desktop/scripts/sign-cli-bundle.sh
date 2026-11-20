#!/usr/bin/env bash
# Signs every Mach-O file in the Intelligence CLI bundle a Mac build carries
# (`tauri.bundled-cli.conf.json`), before `tauri build` pins the runtime's digest (build.rs).
#
# Tauri signs the app's own binary and its frameworks, not its resources, and notarization refuses
# any Mach-O in the app that is not signed with a Developer ID Application certificate, with the
# hardened runtime and a secure timestamp. The bundle has such files of its own: Node, which ships
# with `get-task-allow`, and native modules npm installs signed for the Mac App Store. Each is
# signed again here with this build's identity. Node gets the entitlements V8 needs under the
# hardened runtime (cli-bundle.entitlements.plist) and nothing else.
#
# Usage: sign-cli-bundle.sh <cli-bundle> <identity> <entitlements>
# An identity of `-` signs ad hoc, with no timestamp, for a local build.
set -euo pipefail

bundle="${1:?the cli-bundle folder}"
identity="${2:?the signing identity, or - for ad hoc}"
entitlements="${3:?the entitlements for the runtime}"

node="$bundle/runtime/node"
test -f "$node" || { echo "No runtime at $node" >&2; exit 1; }
timestamp=--timestamp
if [ "$identity" = "-" ]; then
  timestamp=--timestamp=none
fi

others=0
while IFS= read -r -d '' file; do
  [ "$file" = "$node" ] && continue
  case "$(file -b "$file")" in
    *Mach-O*)
      codesign --force --sign "$identity" --options runtime "$timestamp" "$file"
      others=$((others + 1))
      ;;
  esac
done < <(find "$bundle" -type f -print0)

codesign --force --sign "$identity" --options runtime "$timestamp" \
  --entitlements "$entitlements" "$node"
codesign --verify --strict "$node"
echo "Signed the runtime and $others other Mach-O files in $bundle."
