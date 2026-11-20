#!/usr/bin/env bash
#
# Set .env up for the personal edition: every key in .env.personal.example, written into .env with
# any earlier line for the same key removed, so each key appears once. Starts from .env.example when
# there is no .env yet. Safe to rerun.
#
# ENV_FILE names another file to write, for tests.

. "$(dirname "$0")/require-bash.sh"

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT/.env.example" "$ENV_FILE"
  printf '\033[2m%s\033[0m\n' "No .env yet, so started one from .env.example."
fi

while IFS= read -r line; do
  case "$line" in
    '' | '#'*) continue ;;
  esac
  name="${line%%=*}"
  tmp="$(mktemp)"
  grep -vE "^$name=" "$ENV_FILE" > "$tmp" || true
  printf '%s\n' "$line" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
done < "$ROOT/.env.personal.example"

printf '\033[32m%s\033[0m\n' "Set .env up for the personal edition."
printf '%s\n' "Fill in OPENAI_API_KEY and the Intelligence settings in .env, then run: bash scripts/start.sh"
