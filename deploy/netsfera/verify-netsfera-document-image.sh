#!/bin/sh
# Inspect bytes from a stopped exact-image candidate with an offline Bun reader.
set -eu
set +x
test "$#" -eq 2 || exit 64
readonly exact_reference="$1"
readonly parent_directory="$2"
readonly bun_image='oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4'
umask 077
directory="$(mktemp -d "${parent_directory}/document-package-probe.XXXXXX")"
probe="openbot-document-package-$(basename "$directory")-$$"
reader="${probe}-reader"
child=''
created=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  failed=0
  if test -n "$child"; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    if docker container inspect "$reader" >/dev/null 2>&1; then docker rm -f "$reader" >/dev/null 2>&1 || failed=1; fi
  fi
  if test "$created" -eq 1; then docker rm -f "$probe" >/dev/null 2>&1 || failed=1; fi
  rm -rf "$directory" || failed=1
  test "$failed" -eq 0 || exit 71
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
created=1
container="$(docker create --name "$probe" --entrypoint /bin/true "$exact_reference")"
test "$(printf '%s' "$container" | grep -Ec '^[a-f0-9]{64}$')" -eq 1 || exit 65
mkdir -p "$directory/examples"
for path in server shared node_modules; do docker cp "${container}:/app/${path}" "$directory/$path"; done
docker cp "${container}:/app/examples/netsfera" "$directory/examples/netsfera"
docker run --rm --name "$reader" --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid \
  -v "${directory}:/app:ro" -w /app "$bun_image" \
  bun server/scripts/verify-netsfera-document-package.ts examples/netsfera &
child=$!
wait "$child"
child=''
