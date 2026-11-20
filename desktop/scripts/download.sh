# shellcheck shell=bash
# How the desktop scripts download from GitHub. Sourced, not run:
#   source "$(dirname "${BASH_SOURCE[0]}")/download.sh"
#   download -o file "$url"
#
# The same patience the app has when it downloads (deployment::get in src-tauri/src/deployment.rs):
#
#   - Connecting may take DOWNLOAD_CONNECT_SECONDS (15).
#   - After that, a download may go DOWNLOAD_STALL_SECONDS (30) without a byte arriving, the answer
#     included, and is then given up (curl's --speed-limit 1 --speed-time). Nothing caps the whole
#     download, so a slow line that keeps arriving is never cut off.
#   - A failed attempt is tried again DOWNLOAD_RETRIES (5) times, curl waiting 1, 2, 4, 8 and 16
#     seconds between. --retry-all-errors, so a stall, a cut connection, a 404 and a 5xx all count.
#
# On 2026-11-08 a plain `curl` asked GitHub for a commit's archive and waited until it was killed by
# hand: GitHub had sent nothing, and nothing told curl to stop waiting.
#
# A retry downloads the whole file again. GitHub answers a byte range of a commit's archive with the
# whole archive, so there is nothing to resume from there.

DOWNLOAD_CONNECT_SECONDS="${DOWNLOAD_CONNECT_SECONDS:-15}"
DOWNLOAD_STALL_SECONDS="${DOWNLOAD_STALL_SECONDS:-30}"
DOWNLOAD_RETRIES="${DOWNLOAD_RETRIES:-5}"

# download <curl arguments>...: curl -fsSL with the patience above.
download() {
  curl -fsSL \
    --connect-timeout "$DOWNLOAD_CONNECT_SECONDS" \
    --speed-limit 1 --speed-time "$DOWNLOAD_STALL_SECONDS" \
    --retry "$DOWNLOAD_RETRIES" --retry-all-errors \
    "$@"
}
