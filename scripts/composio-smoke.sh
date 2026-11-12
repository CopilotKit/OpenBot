#!/usr/bin/env bash
#
# Does this deployment's Composio key actually open Composio? The smoke is a command of the server
# image (`openbot composio-smoke`), run here in a one-off server container with this checkout's
# settings: `.env`, and COMPOSIO_API_KEY from the environment when it is set there.
#
#   bun run composio:smoke -- --user <id> [--call]
#
# Reads only, unless --call. The key is never printed.

. "$(dirname "$0")/require-bash.sh"

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  printf '\033[31m%s\033[0m\n' ".env is missing. Copy .env.example to .env and fill in the required settings." >&2
  exit 1
fi

# The image tag from backend-images.env, then .env and the environment over it, as start.sh reads it.
exec docker compose --env-file backend-images.env --env-file .env \
  run --rm --no-deps -T server openbot composio-smoke "$@"
