// Resolves the *agent signature* — which model did the work, inside which
// harness, at which version — for the Node-side hooks. The shell helpers
// (send-event.sh / send-event.ps1) implement the same contract independently,
// on purpose: they have to keep working with no Node available.
//
// Three layers, in order, for every field:
//   1. an explicit env override (BEACON_MODEL / BEACON_HARNESS / …)
//   2. whatever the harness hands us directly
//   3. the session transcript
// and then nothing. A field this can't determine is *omitted*, never filled
// with "unknown" — a null column is honest about not knowing; a placeholder
// silently becomes a category on the dashboard that nobody meant to create.
//
// Same hard rules as the rest of the skill: never throws past the caller,
// never blocks longer than a bounded read, never reads a secret. The
// transcript is opened for its own `model`/`version` fields only — no message
// content is parsed or forwarded, which is what keeps the standing rule (a
// derived event can never carry model output) true here too.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Transcripts routinely reach tens of megabytes, so the file is never read
// whole — only a window off the end, which is where the most recent assistant
// turn always is. Large enough to clear a few big tool results, small enough
// to be a single cheap read on the hook path.
const TAIL_BYTES = 256 * 1024

// Best-effort environment fingerprints, most specific first. These are the
// variables each tool is known (or strongly expected) to export; a harness
// that isn't listed, or that changes its variables, resolves to nothing and
// the user sets BEACON_HARNESS instead. That escape hatch is why this list
// can afford to be incomplete.
const HARNESS_ENV = [
  ['claude-code', ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']],
  ['cursor', ['CURSOR_TRACE_ID', 'CURSOR_AGENT']],
  ['codex', ['CODEX_HOME', 'CODEX_SANDBOX']],
  ['gemini-cli', ['GEMINI_CLI', 'GEMINI_SANDBOX']],
  ['aider', ['AIDER_MODEL', 'AIDER_CHAT_HISTORY_FILE']],
  ['copilot', ['COPILOT_AGENT', 'GITHUB_COPILOT_CLI']],
  ['windsurf', ['WINDSURF_SESSION_ID', 'WINDSURF_USER']],
  ['cline', ['CLINE_SESSION_ID']],
  ['opencode', ['OPENCODE_SESSION_ID', 'OPENCODE_BIN']],
  ['amp', ['AMP_THREAD_ID']],
  ['replit', ['REPLIT_AGENT', 'REPL_ID']],
  ['devin', ['DEVIN_SESSION_ID']],
]

// Some environments expose a single generic descriptor instead, shaped
// `<name>_<dashed-version>_agent` (e.g. "claude-code_2-1-251_agent"). Worth
// parsing because it carries the version too, but only when it matches —
// anything else is taken as a bare name rather than guessed at.
const AI_AGENT_RE = /^([a-z][a-z0-9-]*)_(\d+(?:-\d+)*)_agent$/i

function clean(value, max) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // Model ids and harness names are plain identifiers; anything with control
  // characters in it is not one, and has no business in a telemetry column.
  const safe = Array.from(trimmed)
    .filter((ch) => {
      const code = ch.codePointAt(0)
      return code > 31 && code !== 127
    })
    .join('')
  return safe ? safe.slice(0, max) : null
}

function compact(fields) {
  const out = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value) out[key] = value
  }
  return out
}

// Claude Code writes synthetic assistant turns with a placeholder model id.
// Those aren't a model anyone chose, so they never count as a resolution.
function realModel(value) {
  const model = clean(value, 120)
  return model && !model.startsWith('<') ? model : null
}

function envHarness() {
  for (const [name, vars] of HARNESS_ENV) {
    if (vars.some((v) => process.env[v])) return { harness: name, harnessVersion: null }
  }
  const generic = clean(process.env.AI_AGENT, 120)
  if (generic) {
    const match = generic.match(AI_AGENT_RE)
    if (match) return { harness: clean(match[1], 60), harnessVersion: clean(match[2].replace(/-/g, '.'), 40) }
    return { harness: clean(generic, 60), harnessVersion: null }
  }
  return { harness: null, harnessVersion: null }
}

// Claude Code names each transcript after the session it belongs to, but files
// them under a per-project directory whose slug isn't worth reconstructing.
// The hook payload normally hands over the path outright; this is the fallback
// for when it doesn't (and for the shell helper's equivalent lookup).
function findTranscript(input, sessionId) {
  const given = input?.transcript_path
  if (typeof given === 'string' && given && fs.existsSync(given)) return given
  if (!sessionId) return null
  const projects = path.join(os.homedir(), '.claude', 'projects')
  try {
    for (const dir of fs.readdirSync(projects)) {
      const candidate = path.join(projects, dir, `${sessionId}.jsonl`)
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {
    // No transcript directory in this environment — not every harness has one.
  }
  return null
}

function readTail(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const { size } = fs.fstatSync(fd)
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Nothing useful to do about a failed close on a read-only handle.
      }
    }
  }
}

// Walks the tail backwards for the most recent assistant turn, so a model
// switched mid-session (/model) is picked up on the next event rather than
// being cached forever. The first line of a tail is almost always truncated
// mid-JSON — a parse failure there is expected, not an error.
function fromTranscript(file) {
  const lines = readTail(file).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || line[0] !== '{') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type !== 'assistant') continue
    const model = realModel(entry.message?.model)
    if (!model) continue
    return { model, harnessVersion: clean(entry.version, 40) }
  }
  return { model: null, harnessVersion: null }
}

/**
 * Returns only the fields it could actually determine, so the result spreads
 * straight into an event body. Absent means absent — an explicit null would be
 * rejected by the API's optional-field validation, and would in any case be
 * claiming to know something this doesn't.
 *
 * @param {{ input?: Record<string, unknown>, sessionId?: string }} options
 * @returns {{ model?: string, harness?: string, harnessVersion?: string }}
 */
export function resolveSignature({ input = {}, sessionId = '' } = {}) {
  const overrides = {
    model: clean(process.env.BEACON_MODEL, 120),
    harness: clean(process.env.BEACON_HARNESS, 60),
    harnessVersion: clean(process.env.BEACON_HARNESS_VERSION, 40),
  }
  if (overrides.model && overrides.harness && overrides.harnessVersion) return compact(overrides)

  // Hook payload shapes aren't guaranteed stable across CLI versions, so this
  // accepts a plain id or an object without assuming either exists.
  const direct = input.model
  const payloadModel = realModel(typeof direct === 'string' ? direct : (direct?.id ?? direct?.display_name))

  const env = envHarness()
  let model = overrides.model ?? payloadModel
  let harnessVersion = overrides.harnessVersion ?? env.harnessVersion

  // Only pay for the file read when it can still tell us something.
  if (!model || !harnessVersion) {
    const file = findTranscript(input, sessionId || input.session_id || '')
    if (file) {
      const found = fromTranscript(file)
      model = model ?? found.model
      harnessVersion = harnessVersion ?? found.harnessVersion
    }
  }

  return compact({ model, harness: overrides.harness ?? env.harness, harnessVersion })
}
