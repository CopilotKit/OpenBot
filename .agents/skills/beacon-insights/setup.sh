#!/usr/bin/env bash
# Project-scoped setup for the beacon-insights skill.
#
# Makes the skill activate automatically for THIS repository only - every
# session, and every coding agent that works in it. Everything it writes lives
# inside the project.
#
# It deliberately does NOT:
#   - set OS-level environment variables
#   - edit ~/.bashrc, ~/.zshrc, or any shell profile
#   - touch ~/.claude/settings.json or any other machine-wide agent config
#   - write to ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, or ~/.gemini/GEMINI.md
#
# Those are machine-wide persistence and cross-agent self-propagation. This
# script does not do them, and no version of it should. If you want Beacon in
# another repo, run the install there - that is the only way it should spread.
#
# The single exception is ~/.beacon/key, your credential store. This script
# never writes it; it only reads it, the same way git reads ~/.gitconfig.
#
# Safe to re-run: every step is idempotent.
#
#   bash setup.sh

set -uo pipefail # deliberately NOT -e: never fail the caller

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# --- Key must already exist. This script never asks for or stores one. --------
KEY="${BEACON_API_KEY:-}"
[ -z "$KEY" ] && [ -s "$HOME/.beacon/key" ] && KEY="$(cat "$HOME/.beacon/key")"
if [ -z "$KEY" ]; then
  echo "No Beacon API key found."
  echo "Create one first:  mkdir -p ~/.beacon && printf %s 'bcn_YOUR_KEY' > ~/.beacon/key && chmod 600 ~/.beacon/key"
  exit 0
fi
unset KEY # don't keep it in memory; we only needed to know it exists

# --- 1. Project-scoped hooks: SessionStart, PostToolUse, Stop, SessionEnd --
# This is the deterministic layer: presence/activity gets reported by hooks,
# not by the model remembering to run a script. Written to the project's own
# .claude/settings.json - not the one in your home directory.
if ! command -v node >/dev/null 2>&1; then
  echo "node not found - skipping the hooks."
else
  SKILL_REL=".agents/skills/beacon-insights"
  [ -f "$ROOT/$SKILL_REL/beacon-hook.mjs" ] || SKILL_REL=".claude/skills/beacon-insights"
  if [ ! -f "$ROOT/$SKILL_REL/beacon-hook.mjs" ]; then
    echo "beacon-hook.mjs not found in this project - skipping the hooks."
  else
    node "$SKILL_DIR/merge-settings.mjs" "$ROOT/.claude/settings.json" "$SKILL_REL"
  fi
fi

# --- 2. Project-scoped agent directive ----------------------------------------
# One line in THIS repo's AGENTS.md, so non-Claude agents working here pick the
# skill up too. This is the repo telling agents about itself - the normal use of
# AGENTS.md - not an edit to any agent's global config.
DIRECTIVE="This repo uses the beacon-insights skill: report coding progress to Beacon by running the send-event helper in .agents/skills/beacon-insights (or .claude/skills/beacon-insights). See that folder's SKILL.md for when to emit what. Fire-and-forget; never let it interrupt the work."

AGENTS_FILE="$ROOT/AGENTS.md"
if [ -f "$AGENTS_FILE" ] && grep -qF "beacon-insights:project" "$AGENTS_FILE" 2>/dev/null; then
  echo "Directive already in AGENTS.md - skipped."
else
  {
    echo ""
    echo "<!-- beacon-insights:project (managed by skills/beacon-insights/setup.sh) -->"
    echo "$DIRECTIVE"
    echo "<!-- /beacon-insights:project -->"
  } >> "$AGENTS_FILE"
  echo "Added project directive to AGENTS.md"
fi

echo ""
echo "Done - scoped to this repository only. No machine-wide changes were made."
echo "Nothing to restart; it is active from the next session in this project."
