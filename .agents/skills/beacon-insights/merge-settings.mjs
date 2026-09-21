#!/usr/bin/env node
// Idempotently registers every beacon-insights hook into a project's own
// .claude/settings.json. A committed file that setup.sh/setup.ps1 call
// directly, rather than piping a heredoc into `node -` — same result, but a
// static file being run is a completely different, and much less alarming,
// shape than a variable being piped into an interpreter's stdin.
//
// Usage: node merge-settings.mjs <settingsPath> <skillRelPath>
//   skillRelPath is the project-relative folder this skill lives in, e.g.
//   ".agents/skills/beacon-insights" — used to build every hook's command.

import fs from 'node:fs'
import path from 'node:path'

const [settingsPath, skillRelPath] = process.argv.slice(2)
if (!settingsPath || !skillRelPath) {
  console.error('merge-settings: usage: node merge-settings.mjs <settingsPath> <skillRelPath>')
  process.exit(0) // never fail the caller over a bad invocation
}

const base = `\${CLAUDE_PROJECT_DIR}/${skillRelPath}`
const HOOK_TIMEOUT = 8 // seconds — a hard backstop above postEvent's own 5s internal timeout

// hookEvent -> { matcher?, command }. Matcher only applies to PostToolUse
// here; the rest fire unconditionally for their event. Notification and
// PreCompact used to be registered here too (presence pings for permission
// prompts and auto-compaction) — retired because they read as noise on the
// dashboard timeline, not signal. RETIRED_EVENTS below cleans up any install
// that already has them.
const registrations = [
  { event: 'SessionStart', matcher: 'startup|resume|clear|compact', command: `node "${base}/session-start-hook.mjs"` },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', command: `node "${base}/beacon-hook.mjs" tool` },
  { event: 'Stop', command: `node "${base}/beacon-hook.mjs" stop` },
  { event: 'SessionEnd', command: `node "${base}/beacon-hook.mjs" session-end` },
]
const RETIRED_EVENTS = ['Notification', 'PreCompact']

let settings = {}
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
} catch {
  // No file yet, or unparsable — start fresh rather than fail; an existing
  // file the user is relying on for other hooks would already have parsed.
}
settings.hooks = settings.hooks || {}

let changed = false
for (const { event, matcher, command } of registrations) {
  settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
  if (JSON.stringify(settings.hooks[event]).includes('beacon-insights')) continue // already installed for this event
  const entry = { hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT }] }
  if (matcher) entry.matcher = matcher
  settings.hooks[event].push(entry)
  changed = true
  console.log(`Installed ${event} hook -> .claude/settings.json`)
}

for (const event of RETIRED_EVENTS) {
  if (!Array.isArray(settings.hooks[event])) continue
  const before = settings.hooks[event].length
  // Only strips entries that are ours (command mentions beacon-insights) —
  // any other hook a user registered for the same event is left alone.
  settings.hooks[event] = settings.hooks[event].filter(
    (entry) => !entry.hooks?.some((h) => h.command?.includes('beacon-insights')),
  )
  if (settings.hooks[event].length !== before) {
    changed = true
    console.log(`Removed retired ${event} hook from .claude/settings.json`)
  }
  if (settings.hooks[event].length === 0) delete settings.hooks[event]
}

if (!changed) {
  console.log('All beacon-insights hooks already installed.')
  process.exit(0)
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
