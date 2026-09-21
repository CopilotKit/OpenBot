#!/usr/bin/env node
// Claude Code SessionStart hook. Runs at the start of every session (startup,
// resume, clear, compact) IN THE PROJECT THAT INSTALLED IT. setup.sh/setup.ps1
// register this file in the project's own .claude/settings.json - never the
// machine-wide one - so it can only ever affect this repository.
//
// Two jobs, in order:
//   1. Send `agent.session_started` itself. This used to be a text reminder
//      asking the model to send it — the least reliable event in the whole
//      skill, because it depended on the model acting on a reminder before
//      doing anything else. Sending it here means it happens whether or not
//      the model ever reads the reminder.
//   2. Inject a short reminder covering what hooks can't do — the semantic
//      events (planning, completed) — since
//      those still need the model. Presence/heartbeat no longer does.
//
// When there's no key, or the user opted out, this does nothing at all.

import { readFileSync } from 'node:fs'
import {
  hasKey,
  isDisabled,
  getGitInfo,
  postEvent,
  pruneOldState,
  recentFailures,
  cap,
} from './beacon-client.mjs'
import { resolveSignature } from './agent-signature.mjs'

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return {}
  }
}

async function main() {
  if (isDisabled()) return
  if (!hasKey()) return

  const input = readStdinJson()
  const cwd = input.cwd || process.cwd()
  const sessionId = input.session_id || ''
  const trigger = input.source || 'startup' // startup | resume | clear | compact — SessionStart's own field is called `source`, distinct from the event's `source` (ingestion channel) below

  pruneOldState()

  const { repo, engineer, task } = getGitInfo(cwd)
  if (sessionId) {
    await postEvent({
      type: 'agent.session_started',
      source: 'agent',
      repo: cap(repo, 200),
      engineer: cap(engineer, 128),
      task,
      sessionId,
      instrumentation: 'hook',
      skillVersion: '2',
      summary: trigger === 'resume' ? 'Resumed work on the task' : 'Started working on the task',
      // On a cold `startup` the transcript has no assistant turn yet, so
      // `model` is usually absent here and arrives with the first heartbeat
      // instead; `resume` and `compact` resolve it straight away. The harness
      // is environment-derived and so is always known.
      ...resolveSignature({ input, sessionId }),
      externalId: `bcn:${sessionId}:session-start`,
    })
  }

  // The literal invocation belongs here, not only in SKILL.md. This text is the
  // one channel guaranteed to reach the agent every session; SKILL.md only
  // arrives if the agent chooses to load the skill.
  const failures = recentFailures(3)
  const failureNote =
    failures.length >= 3
      ? '\nHeads up: the last few Beacon sends failed locally (see ~/.beacon/errors.log) — presence is still tracked by hooks, but if this persists the API key may need rotating.\n'
      : ''

  const additionalContext =
    'Beacon insights is active for this project. Presence and activity are now reported automatically by hooks — you do not need to run anything for the dashboard to show this session is live. ' +
    'Start by calling the Beacon MCP get_plan_context tool. If there is no plan today, ask the user what they want to get done, turn their answer into a concise checklist, and add it with add_plan_tasks. Keep the returned plan task id with related progress events; offline tasks need no progress. ' +
    'What hooks cannot see is *why* — two moments still need you to say something, each time it genuinely happens, with no fixed cadence to track:\n' +
    '  - agent.planning, once you have formed a plan\n' +
    '  - agent.completed, once the task is verified done\n' +
    'Send these with the helper, from the repo:\n' +
    '  bash ~/.claude/skills/beacon-insights/send-event.sh --type agent.planning --plan-task PLAN_TASK_ID --summary "plain-language outcome"\n' +
    '  (Windows: powershell -File ~/.claude/skills/beacon-insights/send-event.ps1 -Type agent.planning -Summary "…")\n' +
    'Every summary must explain the outcome to a non-technical reader; never mention filenames, commands, tools, symbols, or edited-file counts. If that path is not present in this environment, use whichever of .agents/skills/beacon-insights/ or .claude/skills/beacon-insights/ (project-relative) exists instead — see SKILL.md section 1, step 3. ' +
    'If a genuinely noteworthy thing happens that neither covers, agent.heartbeat with a one-line summary is fine too — but there is no longer a tool-call count to track; only send it when there is something worth saying. ' +
    'It is fire-and-forget — never let it interrupt or slow the actual work. Full guidance: that folder\'s SKILL.md.' +
    failureNote

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }),
  )
}

await main().catch(() => {}) // a hook must never fail the session it's starting
