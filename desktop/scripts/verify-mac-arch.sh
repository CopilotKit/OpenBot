#!/usr/bin/env bash
# Checks that a built OpenBot.app is an app for one architecture: every Mach-O file in it (the app,
# its frameworks, the bundled Node runtime and every native module of the Intelligence CLI) carries
# that architecture, as `lipo -archs` reports it.
#
# Both Mac installers are built on the Apple silicon runner, the Intel one with
# `--target x86_64-apple-darwin` (desktop/scripts/signed-build.ts). A step that quietly used the
# runner's own architecture, such as npm picking a native module for the machine it runs on, gives
# an Intel app that installs and then fails on every Intel Mac. This is where that stops the build.
#
# One exception: a package that ships a copy for each architecture and picks one at run time, such
# as `dist/macos/arm64/` beside `dist/macos/x64/`. A file in a folder named for another architecture
# is accepted when the same folder named for this architecture is beside it.
#
# Usage: verify-mac-arch.sh <OpenBot.app> <x86_64|arm64>
# Prints every Mach-O file with its architectures. With ROSETTA_CHECK=1 on an Apple silicon Mac that
# has Rosetta, an x86_64 app's Node runtime is also started under it, once, to show it runs.
set -euo pipefail

app="${1:?the .app}"
arch="${2:?x86_64 or arm64}"
case "$arch" in
  x86_64)
    own=(x86_64 x64 amd64)
    others=(arm64 aarch64)
    ;;
  arm64)
    own=(arm64 aarch64)
    others=(x86_64 x64 amd64)
    ;;
  *)
    echo "::error::The architecture must be x86_64 or arm64, got '$arch'." >&2
    exit 1
    ;;
esac
if [ ! -d "$app/Contents" ]; then
  echo "::error::$app is not an app bundle." >&2
  exit 1
fi

# Whether `file`, inside the app, sits in a folder named for another architecture that has a twin
# named for this one beside it. The folder's name may hold the architecture as one of its parts, as
# in `darwin-arm64`, whose twin is `darwin-x64`.
has_own_twin() {
  local dir
  dir="$(dirname "$1")"
  while [ "${#dir}" -gt "${#app}" ]; do
    local name parent other mine twin
    name="$(basename "$dir")"
    parent="$(dirname "$dir")"
    for other in "${others[@]}"; do
      if [[ "$name" =~ ^(.*[-_.])?${other}([-_.].*)?$ ]]; then
        for mine in "${own[@]}"; do
          twin="${BASH_REMATCH[1]}${mine}${BASH_REMATCH[2]}"
          if [ -d "$parent/$twin" ]; then
            return 0
          fi
        done
      fi
    done
    dir="$parent"
  done
  return 1
}

checked=0
twins=0
wrong=()
# One `file` for every file in the app, not one per file: the CLI's node_modules are thousands of
# files. `-0` ends each name with a NUL, then ": <description>" and a newline.
while IFS= read -r -d '' file && IFS= read -r kind; do
  case "$kind" in
    *Mach-O*) ;;
    *) continue ;;
  esac
  archs="$(lipo -archs "$file" 2>/dev/null || true)"
  printf '%-14s %s\n' "${archs:-unknown}" "${file#"$app"/}"
  checked=$((checked + 1))
  if [[ " $archs " == *" $arch "* ]]; then
    continue
  fi
  if has_own_twin "$file"; then
    twins=$((twins + 1))
    continue
  fi
  wrong+=("${file#"$app"/} ($archs)")
done < <(find "$app" -type f -exec file -0 -N {} +)

if [ "$checked" -eq 0 ]; then
  echo "::error::$app holds no Mach-O file." >&2
  exit 1
fi
if [ "${#wrong[@]}" -gt 0 ]; then
  for entry in "${wrong[@]}"; do
    echo "::error::Not built for $arch: $entry" >&2
  done
  exit 1
fi

# The app's own executable and the bundled runtime are the two that always start. Each must be this
# architecture, not only beside one.
main="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
for required in "Contents/MacOS/$main" Contents/Resources/cli-bundle/runtime/node; do
  if [ -f "$app/$required" ] && [[ " $(lipo -archs "$app/$required") " != *" $arch "* ]]; then
    echo "::error::$required is not built for $arch." >&2
    exit 1
  fi
done

if [ "${ROSETTA_CHECK:-}" = 1 ] && [ "$arch" = x86_64 ] && [ "$(uname -m)" = arm64 ]; then
  node="$app/Contents/Resources/cli-bundle/runtime/node"
  if [ -f "$node" ] && arch -x86_64 /usr/bin/true 2>/dev/null; then
    echo "The bundled Node runs as x86_64: $(arch -x86_64 "$node" --version)"
  else
    echo "Rosetta is not available here, so the bundled Node was not started."
  fi
fi

echo "$((checked - twins)) of the $checked Mach-O files in $app carry $arch; the other $twins are another architecture's copies, each beside its $arch twin."
