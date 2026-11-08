#!/usr/bin/env bash
# Build OpenBot Desktop on this Mac as an internal build would, from this checkout's HEAD.
#
# What the Internal build workflow does on GitHub (images.yml, then desktop-build.yml), done here:
#
#   1. HEAD is pushed to its branch on origin. A pinned app lays out its deployment from
#      https://github.com/CopilotKit/OpenBot/archive/<commit>.tar.gz (deployment::fetch_pinned), so
#      the commit has to be on GitHub. Never main, never forced.
#   2. A registry runs in Docker on 127.0.0.1 only (container `openbot-local-registry`).
#   3. The images a Claude-plan install runs are built from HEAD for linux/arm64 and pushed to it.
#   4. container-images.json is written: those images by their pushed digest, every other image at
#      the latest release's ghcr digest, `version` local-<12 char commit>, `commit` HEAD.
#   5. The app is built pinned to that manifest (OPENBOT_PINNED_DEPLOYMENT), with the bundled CLI,
#      ad-hoc signed, and copied out of the shared target directory. Its path is printed.
#
# Everything is built from HEAD: the images, the app and the archive the app downloads all have to
# be the same commit. Commit first, then run this; uncommitted changes the app compiles are refused. Running it again on the same commit is safe; Docker and
# Cargo caches make the second run mostly a no-op.
#
# Only Docker can pull these images. Podman's machine has its own loopback and wants TLS, so a
# local build installed on Podman fails at the pull.
#
# Settings, all optional:
#   OPENBOT_LOCAL_IMAGES         Images to build from HEAD, space separated. Unset: the four a Claude
#                                plan runs. Empty: none, every image comes from the base release.
#   OPENBOT_LOCAL_BASE_RELEASE   Release whose images fill in the rest. Default: the latest release.
#   OPENBOT_LOCAL_REGISTRY_PORT  Default 5050.
#   OPENBOT_LOCAL_BUILD_DIR      Where manifests, logs and apps go. Default ~/.openbot-local-build.
#   OPENBOT_LOCAL_NO_PUSH=1      Do not push HEAD (it must already be on GitHub).
#   CARGO_TARGET_DIR             Default: the main checkout's desktop/src-tauri/target, so worktrees
#                                share one Rust build cache.
set -euo pipefail

REPOSITORY="CopilotKit/OpenBot"
REGISTRY_NAME="openbot-local-registry"
REGISTRY_PORT="${OPENBOT_LOCAL_REGISTRY_PORT:-5050}"
REGISTRY="127.0.0.1:${REGISTRY_PORT}"
STATE="${OPENBOT_LOCAL_BUILD_DIR:-$HOME/.openbot-local-build}"
# server (server, migrate, worker), supervisor, agent-computer, and agent-claude-sdk (the harness a
# Claude plan picks and the sign-in image). `docker ps` on a Claude-plan install shows these four.
DEFAULT_IMAGES="server supervisor agent-computer agent-claude-sdk"
IMAGES=()
for image in ${OPENBOT_LOCAL_IMAGES-$DEFAULT_IMAGES}; do IMAGES+=("$image"); done

export PATH="$HOME/.cargo/bin:$PATH"

started=$SECONDS
stage_started=$SECONDS
timings=()
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nlocal-build: %s\n' "$*" >&2; exit 1; }
stage() {
  local name=$1
  stage_started=$SECONDS
  say "$name"
  current_stage=$name
}
stage_done() {
  local took=$((SECONDS - stage_started))
  timings+=("$(printf '%-28s %4ss' "$current_stage" "$took")")
}
# Run a noisy command into a log, showing its tail only when it fails.
logged() {
  local log=$1
  shift
  if ! "$@" > "$log" 2>&1; then
    tail -n 60 "$log" >&2
    die "failed: $* (full log: $log)"
  fi
}

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"
# shellcheck source-path=SCRIPTDIR source=download.sh
source "$ROOT/desktop/scripts/download.sh"

# --- Preconditions -------------------------------------------------------------------------------
stage "check the checkout"
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "this builds the Apple silicon app; run it on an arm64 Mac"
for tool in git docker jq curl gh bun cargo ditto codesign; do
  command -v "$tool" > /dev/null || die "$tool is not on PATH"
done
docker info > /dev/null 2>&1 || die "Docker is not running"
# The images come from `git archive HEAD` and the deployment from GitHub, so uncommitted work only
# reaches the build through what the app compiles from the working tree: these paths. A change
# there is refused; a change anywhere else is left out of the build, and said so.
APP_INPUTS=(desktop shared scripts docker-compose.yml package.json bun.lock .github)
if [ -n "$(git status --porcelain -- "${APP_INPUTS[@]}")" ]; then
  git status --short -- "${APP_INPUTS[@]}" >&2
  die "uncommitted changes in what the app is built from. Commit them first: the images and the deployment the app downloads are the commit, so the app has to be too."
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes, NOT in this build (it builds HEAD):"
  git status --short
fi
COMMIT="$(git rev-parse HEAD)"
SHORT="${COMMIT:0:12}"
VERSION="local-${SHORT}"
BRANCH="$(git symbolic-ref --short -q HEAD)" || die "HEAD is detached; check out a branch"
[ "$BRANCH" != main ] || die "refusing to push main; build from a branch"
TARGET_DIR="${CARGO_TARGET_DIR:-$(cd "$(git rev-parse --git-common-dir)/.." && pwd)/desktop/src-tauri/target}"
LOGS="$STATE/logs/$SHORT"
mkdir -p "$LOGS" "$STATE/manifests" "$STATE/apps"
echo "commit $COMMIT on $BRANCH, manifest version $VERSION"
stage_done

# --- 1. The commit on GitHub ---------------------------------------------------------------------
stage "push $BRANCH"
if [ "${OPENBOT_LOCAL_NO_PUSH:-}" != 1 ]; then
  remote="$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)"
  if [ "$remote" = "$COMMIT" ]; then
    echo "origin/$BRANCH is already $SHORT"
  else
    git push origin "HEAD:refs/heads/$BRANCH" || die "could not push $BRANCH. If origin has commits this branch lacks, pull them first; this never force-pushes."
  fi
fi
archive="https://github.com/$REPOSITORY/archive/$COMMIT.tar.gz"
# Downloaded whole: GitHub ignores a byte range on an archive. Through download.sh, so a GitHub that
# stops sending is given up after 30 seconds and tried again, never waited on forever.
download -o /dev/null "$archive" \
  || die "GitHub does not serve $archive. The app would fail to lay out its deployment."
echo "GitHub serves $archive"
stage_done

# --- 2. The registry -----------------------------------------------------------------------------
stage "registry on $REGISTRY"
state="$(docker inspect -f '{{.State.Status}}' "$REGISTRY_NAME" 2> /dev/null || true)"
case "$state" in
  running) ;;
  "")
    if lsof -nP -iTCP:"$REGISTRY_PORT" -sTCP:LISTEN > /dev/null 2>&1; then
      die "port $REGISTRY_PORT is taken by something else; set OPENBOT_LOCAL_REGISTRY_PORT"
    fi
    docker run -d --name "$REGISTRY_NAME" --restart unless-stopped \
      -p "$REGISTRY:5000" -v "$REGISTRY_NAME:/var/lib/registry" registry:2 > /dev/null
    ;;
  *) docker start "$REGISTRY_NAME" > /dev/null ;;
esac
for attempt in $(seq 1 20); do
  # A probe of the registry on this Mac, whose answer is a few bytes, so a cap on the whole request
  # is right here.
  curl -fsS --connect-timeout 5 --max-time 10 "http://$REGISTRY/v2/" > /dev/null 2>&1 && break
  [ "$attempt" = 20 ] && die "the registry at $REGISTRY does not answer"
  sleep 1
done
echo "registry answers"
stage_done

# --- 3. The images -------------------------------------------------------------------------------
# Built from `git archive HEAD`, not the working tree, so ignored files on this machine (generated
# config, local builds) cannot end up in an image the way they never would in CI's checkout.
# BUILT collects {name: {repository, digest, reference}} as images.yml writes them. JSON rather than
# an associative array, so this runs on the bash 3.2 macOS ships.
BUILT="{}"
if [ "${#IMAGES[@]}" -gt 0 ]; then
  stage "export $SHORT"
  SRC="$STATE/src"
  rm -rf "$SRC"
  mkdir -p "$SRC"
  git archive "$COMMIT" | tar -x -C "$SRC"
  stage_done
fi
for image in ${IMAGES[@]+"${IMAGES[@]}"}; do
  jq -e --arg image "$image" 'index($image) != null' .github/published-images.json > /dev/null \
    || die "$image is not in .github/published-images.json"
  stage "image $image"
  name="$REGISTRY/openbot-$image"
  meta="$LOGS/$image.metadata.json"
  # The build arguments images.yml passes. Single-architecture and without attestations: this
  # registry only feeds this Mac.
  logged "$LOGS/$image.log" docker buildx build \
    --platform linux/arm64 \
    --file "$SRC/$image/Dockerfile" \
    --build-arg "OPENBOT_BUILD_VERSION=$VERSION" \
    --build-arg "OPENBOT_BUILD_COMMIT=$COMMIT" \
    --build-arg "OPENBOT_BUILD_DISTRIBUTION_ID=$REPOSITORY" \
    --build-arg "OPENBOT_BUILD_REPOSITORY=$REPOSITORY" \
    --build-arg "OPENBOT_BUILD_CHANNEL=stable" \
    --provenance=false --sbom=false \
    --metadata-file "$meta" \
    --tag "$name:sha-$COMMIT" \
    --push \
    "$SRC"
  digest="$(jq -r '."containerimage.digest" // empty' "$meta")"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "the build of $image reported no digest"
  # Read back from the registry, as images.yml does, so a digest that was not pushed fails here.
  code="$(curl -s --connect-timeout 5 --max-time 30 -o /dev/null -w '%{http_code}' \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "http://$REGISTRY/v2/openbot-$image/manifests/$digest")"
  [ "$code" = 200 ] || die "the registry does not have openbot-$image@$digest (HTTP $code)"
  BUILT="$(jq --arg name "$image" --arg repository "$name" --arg digest "$digest" \
    '. + {($name): {repository: $repository, digest: $digest, reference: ($repository + "@" + $digest)}}' <<< "$BUILT")"
  echo "$name@$digest"
  stage_done
done

# --- 4. The manifest -----------------------------------------------------------------------------
stage "manifest $VERSION"
BASE="${OPENBOT_LOCAL_BASE_RELEASE:-$(gh release view -R "$REPOSITORY" --json tagName -q .tagName)}"
base="$STATE/manifests/base-$BASE.json"
if [ ! -s "$base" ]; then
  gh release download "$BASE" -R "$REPOSITORY" -p container-images.json -O "$base.tmp"
  mv "$base.tmp" "$base"
fi
MANIFEST="$STATE/manifests/container-images-$SHORT.json"
jq --arg version "$VERSION" --arg commit "$COMMIT" --argjson built "$BUILT" \
  '.version = $version | .commit = $commit | .images += $built' "$base" > "$MANIFEST"
# Every image the published list names must be pinned, or the app refuses the manifest at Install.
jq -e --slurpfile names .github/published-images.json \
  '[$names[0][] as $n | .images[$n].reference // "" | test("@sha256:[0-9a-f]{64}$")] | all' \
  "$MANIFEST" > /dev/null || die "$MANIFEST does not pin every published image"
echo "$MANIFEST (others from $BASE)"
stage_done

# --- 5. Docker can pull what the app will ask for ------------------------------------------------
stage "pull check"
for ref in $(jq -r '.[].reference' <<< "$BUILT"); do
  logged "$LOGS/pull-${ref##*/}.log" docker pull "$ref"
  echo "pulled $ref"
done
stage_done

# --- 6. The app ----------------------------------------------------------------------------------
# desktop-build.yml's steps for macOS, without the dmg: an .app is what gets installed.
stage "app dependencies"
cd "$ROOT/desktop"
logged "$LOGS/bun-install.log" bun install --frozen-lockfile
logged "$LOGS/desktop-version.log" bun scripts/desktop-version.ts internal
cd "$ROOT"
logged "$LOGS/cli-bundle.log" bun desktop/scripts/cli-bundle.ts darwin arm64
stage_done

stage "app build"
cd "$ROOT/desktop"
logged "$LOGS/tauri-build.log" env \
  CARGO_TARGET_DIR="$TARGET_DIR" \
  APPLE_SIGNING_IDENTITY=- \
  OPENBOT_BUNDLED_CLI=1 \
  OPENBOT_PINNED_DEPLOYMENT="$MANIFEST" \
  bun run tauri build \
  --config src-tauri/tauri.build-version.conf.json \
  --config src-tauri/tauri.bundled-cli.conf.json \
  --bundles app
cd "$ROOT"
built_app="$TARGET_DIR/release/bundle/macos/OpenBot.app"
[ -d "$built_app" ] || die "the build made no $built_app"
APP_DIR="$STATE/apps/$VERSION"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
ditto "$built_app" "$APP_DIR/OpenBot.app"
APP="$APP_DIR/OpenBot.app"
stage_done

stage "check the app"
plist="$APP/Contents/Info.plist"
revision="$(/usr/libexec/PlistBuddy -c 'Print :OpenBotSourceRevision' "$plist")"
[ "$revision" = "$COMMIT" ] || die "the app says it is $revision, not $COMMIT"
binary="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
LC_ALL=C grep -aq "\"$VERSION\"" "$binary" || die "the app binary does not carry the $VERSION manifest; it was not built pinned"
codesign --verify --deep --strict "$APP" || die "the app's ad-hoc signature does not verify"
[ -d "$APP/Contents/Resources/cli-bundle" ] || die "the app has no bundled CLI"
ln -sfn "$APP_DIR" "$STATE/apps/latest"
echo "$(/usr/libexec/PlistBuddy -c 'Print :OpenBotBuildVersion' "$plist"), pinned to $VERSION"
stage_done

# --- Summary -------------------------------------------------------------------------------------
say "done in $((SECONDS - started))s"
printf '  %s\n' "${timings[@]}"
echo
echo "Manifest: $MANIFEST"
jq -r '.images | to_entries[] | "  \(.key)\t\(.value.reference)"' "$MANIFEST" | column -t
echo
echo "App: $APP"
echo "Install: quit OpenBot, then  rm -rf /Applications/OpenBot.app && ditto \"$APP\" /Applications/OpenBot.app"
