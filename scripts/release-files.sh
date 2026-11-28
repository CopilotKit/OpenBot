#!/usr/bin/env bash
# Fetches the release files the OpenBot images of one tag were published with, into a folder:
#
#   openbot-<chart version>.tgz          the `openbot` Helm chart, packaged
#   openbot-bundle-<chart version>.tgz   the `openbot-bundle` Helm chart, packaged
#   openbot-release.json                 names both, with their checksums, and the last migration
#                                        the server of that tag applies
#
# They are published beside the images, as `ghcr.io/copilotkit/openbot:charts-<tag>`, and signed with
# the same key (docs/cosign.pub). Nothing is fetched until that signature verifies, and what is
# fetched is the digest the signature names, never the tag again, so a tag moved in between changes
# nothing. `scripts/release-manifest.ts` reads the folder (OPENBOT_RELEASE_FILES) and holds every
# file in it to the release being published.
#
# Usage: scripts/release-files.sh <tag | sha256:digest> <directory>
#   A tag is the OpenBot images' tag, such as v1.2.3. A digest fetches exactly what an earlier call
#   verified. Prints the digest fetched, and nothing else, on stdout.
#
# Needs cosign, docker and jq.
set -euo pipefail

reference="${1:?Name the OpenBot images tag, such as v1.2.3, or the sha256: digest of its release files}"
directory="${2:?Name the folder to write the release files into}"
repository="ghcr.io/copilotkit/openbot"
key="$(cd "$(dirname "$0")/.." && pwd)/docs/cosign.pub"

case "$reference" in
  sha256:*) image="$repository@$reference" ;;
  *) image="$repository:charts-$reference" ;;
esac

if ! signed="$(cosign verify --key "$key" --insecure-ignore-tlog=true "$image")"; then
  echo "::error::$image is not there, or is not signed with OpenBot's key. The OpenBot images of this release publish it; publish them at this tag first." >&2
  exit 1
fi
digest="$(jq -r '.[0].critical.image["docker-manifest-digest"] // empty' <<<"$signed")"
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::cosign named no digest for $image." >&2
  exit 1
fi

# The files are the whole image: a folder, /release, and nothing to run. A container is made from it,
# never started, only so its files can be copied out.
container="$(docker create "$repository@$digest" /release)"
trap 'docker rm -f "$container" >/dev/null' EXIT
mkdir -p "$directory"
docker cp "$container:/release/." "$directory" >&2
echo "$digest"
