// Shared helpers for the Node-side hooks (session-start-hook.mjs, beacon-hook.mjs).
// The model-invoked path (send-event.sh / send-event.ps1) stays independent on
// purpose — it has to work with no Node available. This module exists so the
// *hook* path, which always runs under Node already, isn't duplicating the same
// key/url resolution, git lookup, and throttle-state logic six times over.
//
// Same hard rules as send-event.sh: fire-and-forget, never throw past the
// caller, never block a hook longer than it has to, never print the key.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const BEACON_DIR = path.join(os.homedir(), '.beacon')
const STATE_DIR = path.join(BEACON_DIR, 'state')
const ERROR_LOG = path.join(BEACON_DIR, 'errors.log')
const DEFAULT_URL = 'https://www.heybeacon.co'

export function isDisabled() {
  return fs.existsSync(path.join(BEACON_DIR, 'disabled'))
}

function readTrimmed(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

export function resolveKey() {
  return process.env.BEACON_API_KEY || readTrimmed(path.join(BEACON_DIR, 'key'))
}

export function resolveUrl() {
  const url = process.env.BEACON_URL || readTrimmed(path.join(BEACON_DIR, 'url')) || DEFAULT_URL
  return url.replace(/\/+$/, '')
}

// Existence only — never read the key just to decide whether one exists. A
// stat is enough and it means this function can never leak a value to a log
// or an error path by accident.
export function hasKey() {
  if (process.env.BEACON_API_KEY) return true
  try {
    return fs.statSync(path.join(BEACON_DIR, 'key')).size > 0
  } catch {
    return false
  }
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

// Everything derivable from git state without asking the model — repo,
// engineer, and (when the branch follows a ticket-style naming convention)
// task. The model can still override `task` when it knows better; this just
// means the common case never depends on it remembering to.
export function getGitInfo(cwd) {
  let repo = ''
  const remote = git(cwd, ['remote', 'get-url', 'origin'])
  if (remote) {
    const cleaned = remote.replace(/\.git$/, '')
    repo = `${path.basename(path.dirname(cleaned))}/${path.basename(cleaned)}`
  } else {
    const top = git(cwd, ['rev-parse', '--show-toplevel'])
    repo = path.basename(top || cwd)
  }

  const engineer = git(cwd, ['config', 'user.name']) || git(cwd, ['config', 'user.email'])
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const task = branch.match(/\b([A-Z][A-Z0-9]+-\d+)\b/)?.[1]

  return { repo, engineer, branch, task }
}

function sessionStatePath(sessionId) {
  return path.join(STATE_DIR, `${sessionId}.json`)
}

export function readSessionState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionStatePath(sessionId), 'utf8'))
  } catch {
    return {}
  }
}

// Atomic write (temp + rename) — a hook can be killed mid-write (the parent
// process exiting) and a half-written state file would otherwise corrupt the
// next read silently.
export function writeSessionState(sessionId, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const target = sessionStatePath(sessionId)
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, target)
  } catch {
    // Best-effort — a failed state write just means the next hook call
    // re-derives from scratch, not a crash.
  }
}

// Called opportunistically from session-start — state files are small but
// there's no other natural cleanup point across many short-lived sessions.
export function pruneOldState(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    const now = Date.now()
    for (const name of fs.readdirSync(STATE_DIR)) {
      const file = path.join(STATE_DIR, name)
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.rmSync(file, { force: true })
    }
  } catch {
    // No state dir yet, or a transient FS error — nothing to prune either way.
  }
}

function logFailure(line) {
  try {
    fs.mkdirSync(BEACON_DIR, { recursive: true })
    const stamped = `${new Date().toISOString()} ${line}\n`
    fs.appendFileSync(ERROR_LOG, stamped)
    // Cap it crudely rather than pulling in a rotation dependency: if it's
    // grown past ~200 lines, keep only the most recent half.
    const lines = readTrimmed(ERROR_LOG).split('\n')
    if (lines.length > 200) fs.writeFileSync(ERROR_LOG, lines.slice(-100).join('\n') + '\n')
  } catch {
    // Logging the failure must never itself be able to fail the caller.
  }
}

// Reads back the last few failure lines so session-start can mention them —
// the one place surfacing "your last N sends failed" costs nothing, because
// it's already the moment the agent is about to tell the user something.
export function recentFailures(count = 3) {
  const lines = readTrimmed(ERROR_LOG).split('\n').filter(Boolean)
  return lines.slice(-count)
}

// Fire-and-forget POST. Never throws. Returns true/false for callers that
// want to decide whether to update local throttle state on success only.
export async function postEvent(body) {
  if (isDisabled()) return false
  const key = resolveKey()
  if (!key) return false
  const url = resolveUrl()

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(`${url}/api/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      logFailure(`HTTP ${res.status} sending ${body.type ?? '(batch)'}`)
      return false
    }
    return true
  } catch (err) {
    logFailure(`${err?.name === 'AbortError' ? 'timeout' : (err?.message ?? 'unknown error')} sending ${body.type ?? '(batch)'}`)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

// Field caps matching what SKILL.md documents but nothing previously
// enforced — a truncated field is a working event; an oversized one risks
// the request itself being rejected.
export function cap(value, max) {
  if (typeof value !== 'string') return value
  return value.length > max ? value.slice(0, max) : value
}
