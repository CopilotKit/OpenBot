#!/usr/bin/env bash
# Checks that a built OpenBot.app carries the Intelligence CLI, and that every Mach-O file in it is
# signed the way notarization requires: with a Developer ID Application certificate of the app's own
# team, the hardened runtime, a secure timestamp and no `get-task-allow`. See sign-cli-bundle.sh.
#
# Usage: verify-cli-bundle.sh <OpenBot.app> developer-id|adhoc
# `adhoc` checks a local build, which has no timestamp and no team to compare.
set -euo pipefail

app="${1:?the .app}"
mode="${2:?developer-id or adhoc}"
bundle="$app/Contents/Resources/cli-bundle"
team="$(codesign -dv --verbose=4 "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')" || team=""
if [ "$mode" = developer-id ] && { [ -z "$team" ] || [ "$team" = "not set" ]; }; then
  echo "::error::$app has no team to compare the CLI's signatures with." >&2
  exit 1
fi

for required in runtime/node cli/index.js; do
  if [ ! -f "$bundle/$required" ]; then
    echo "::error::$app has no bundled CLI: $required is missing." >&2
    exit 1
  fi
done

checked=0
while IFS= read -r -d '' file; do
  case "$(file -b "$file")" in
    *Mach-O*) ;;
    *) continue ;;
  esac
  name="${file#"$bundle"/}"
  codesign --verify --strict "$file"
  details="$(codesign -dv --verbose=4 "$file" 2>&1)"
  if ! grep -q 'flags=.*runtime' <<<"$details"; then
    echo "::error::$name does not have the hardened runtime." >&2
    exit 1
  fi
  if [ "$mode" = developer-id ]; then
    grep -q '^Authority=Developer ID Application: ' <<<"$details" &&
      grep -qx "TeamIdentifier=$team" <<<"$details" || {
      echo "::error::$name is not signed with the app's own Developer ID ($team)." >&2
      exit 1
    }
    grep -q '^Timestamp=' <<<"$details" || {
      echo "::error::$name has no secure timestamp." >&2
      exit 1
    }
  fi
  if codesign -d --entitlements - --xml "$file" 2>/dev/null | grep -q 'get-task-allow'; then
    echo "::error::$name requests get-task-allow, which notarization refuses." >&2
    exit 1
  fi
  checked=$((checked + 1))
done < <(find "$bundle" -type f -print0)

echo "The app carries the CLI; $checked Mach-O files in it are signed for notarization."
