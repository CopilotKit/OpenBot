#!/usr/bin/env bash
# The system libraries the Linux shell links against, for the Desktop workflow's Linux jobs.
#
# Usage: install-linux-build-deps.sh <archive folder>
#
# The archive folder is where apt keeps the .deb files it installs, and the job caches it. When the
# cache holds every package, they install with no download at all: a runner once spent 13 minutes
# in `apt-get update` and the downloads after it, waiting on Ubuntu's mirrors. apt checks each kept
# file against the runner image's signed package lists before installing it, so a kept file that
# does not match is never installed. When anything is missing (a first run, or an image whose lists
# name newer versions), it updates the lists and downloads, as a plain install would, and keeps what
# it downloaded for the next run.
set -euo pipefail

archives="${1:?usage: install-linux-build-deps.sh <archive folder>}"
packages=(libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf)
options=(-y -qq -o "Dir::Cache::Archives=$archives" -o Acquire::Retries=3)

mkdir -p "$archives/partial"
if sudo apt-get install "${options[@]}" --no-download "${packages[@]}"; then
  echo "Installed ${packages[*]} from the cached archives."
else
  echo "The cached archives do not hold everything; updating the package lists and downloading."
  sudo apt-get update -qq -o Acquire::Retries=3
  sudo apt-get install "${options[@]}" "${packages[@]}"
fi

# The cache step that saves the folder runs as the runner's user: hand it the files, without apt's
# lock and half-downloaded ones.
sudo rm -rf "$archives/partial" "$archives/lock"
sudo chown -R "$(id -u):$(id -g)" "$archives"
