# Routines

A routine is a standing instruction: something a Bot carries out on a schedule instead of waiting to
be asked. "Every weekday at nine, summarize what changed in this channel overnight" is a routine, not
a message — it fires on its own, for as long as it stays switched on, and its reply lands in a channel
the same way any other message from that Bot does.

## One list

Routines, goals and check-ins are one list, on each Bot's Routines page (`/bots/<id>/routines`) and,
for every Bot at once, on Routines in the main menu (`/routines`). A goal is a routine with an
outcome to reach. A check-in is a routine that only tells you. They stay three stores on the server
(routines, goals in `responsibilities`, check-ins in `proactive` settings), and the page reads all
three and draws them together (`app/src/lib/routines/merged.ts`).

Every row is the same sentence in four parts:

- **What** it is: the routine's instruction, the goal's title, or the Bot's check-in.
- **Starts**: a routine's schedule; for a goal, the routines that run it and the events that wake
  it, or when you ask; for a check-in, at most once an hour.
- **Does**: whether it acts, or only tells you.
- **Until**: until you stop it, or, for a goal, the outcome that completes it.

A routine that runs a goal is not a row of its own: it is one of that goal's starts, so the goal's
row carries it. Rows that are working (on, active, not paused) come first. The every-Bot list also
holds the switch for check-ins from all your Bots. In the team edition an admin turns check-ins on
or off for everybody, and limits them, in Admin → Routines.

Old addresses redirect here: `/responsibilities` to Routines, and
`/bots/<id>/responsibilities` to the Bot's Routines page.

## Creating one

Two ways, and either way a routine or a goal is written by the same store calls.

- **New routine.** Routines and a Bot's Routines page both have **New routine**, which
  opens one screen (`/routines/new`). It asks, in order: **Bot**, **What to do**, **It should** (Act
  for you or Only tell you), **Starts** (On a schedule, When something happens, or Now, once), **Done
  when** (optional), **Posts in**, and **Name**. It does not ask whether you want a routine, a goal
  or a check-in; the answers decide: `planRoutine` (`app/src/lib/routines/plan.ts`) turns them into a
  plan, and `createFromPlanMutationOptions` writes it:
  - Act on a schedule with nothing in Done when is a routine (`POST /api/routines`, which calls
    `routineStore.create` exactly as `create_routine` does).
  - Act on a schedule with an outcome is a goal that ends when met, plus a routine that runs it.
  - Act when something happens is a goal with that subscription.
  - Now, once is a goal, run at once.
  - Only tell you is a check-in, with **How often** in place of Starts and Done when. It is offered
    only while an admin allows check-ins.

  A Bot's own Routines page and the clock beside a conversation's message box open the same screen
  with that Bot already chosen, and from the clock that conversation too
  (`RoutineComposerButton`). If a goal is saved but its schedule is refused, the goal is paused, and
  the screen says why its schedule was refused.
- **Ask a Bot**, in a conversation: "every weekday at 9, post the standup notes here." Anything the
  form's schedules do not cover ("every other Tuesday") goes this way. The same Bot can list what is
  standing, change one, or delete one, all by being asked. There is no edit form.

Connections > Routines points to the Routines page, and the New Bot form shows an example beside
Routines under "Apps it can use".

**Always on.** Every Bot can do this, in every edition. The server adds Routines at startup and gives
every Bot all of its tools, including the write tools `create_routine`, `update_routine` and
`delete_routine`. A Bot made later gets them the first time it runs. Routines can't be turned off, and
its tools can't be taken from a Bot: the server answers `403`. A Bot still asks before each write
while Extra vigilant is on, and `delete_routine` asks as any delete does, unless the person allowed
it for the conversation or always (see [Approvals](approvals.md)). See `server/src/plugins/personal-defaults.ts`.

**Goals too.** The same app carries a goal's tools for a conversation: `create_goal`, `list_goals`,
`update_goal`, `run_goal`, `pause_goal`, `resume_goal` and `complete_goal`, beside the trigger tools
that wake a goal. Asked for a goal, a Bot makes one that reports into the conversation it was asked
in, or into another the person names, and it shows on the Bot's Routines page. A goal has no schedule of
its own: it runs when asked, or when an event wakes it. A goal's own run is not given these copies,
because it already holds the goal's own tools. See `server/src/responsibilities/chat-tools.ts`.

A goal that repeats is never completed by one of its runs. It repeats when it was made `recurring`,
or, unless it was made `endsWhenMet`, when an enabled routine of its Bot runs it or an event wakes
it. Its run is told so, records its result with `report_goal_progress`, and is refused
`complete_goal`; only the person ends it. Asked to run a completed or paused goal, `run_goal` says
so instead of running nothing. See `GoalRepeats` in `server/src/responsibilities/types.ts`.

A goal that a routine or an event starts can still be completed by a run that meets its outcome, when
it is made `endsWhenMet`; without it, a goal a routine or an event starts repeats and a run never
completes it (`repeatsOf` in `server/src/responsibilities/store.ts`). It never combines with `recurring`: the
store and `parseResponsibilityInput` refuse both together. Completing a goal by any path, a run or
the person, switches off the routines that run it (`routineRunsGoal`): those whose `goal_id` is that
goal, and an older routine that names it by id or whole quoted title. An older routine that also
names another goal of its Bot that is not completed stays on, so that goal still repeats; it is
switched off when the last goal it runs completes (`switchOffRoutinesOf`). A goal made on the New routine
screen may have no success criteria, and its run is then told the outcome is that the instruction has
been carried out (`NO_OUTCOME` in `shared/responsibility-turn.ts`); a Bot's `create_goal` still
requires them.

A routine records the goal it runs (`routines.goal_id`): the `goalId` passed to `create_routine`, `update_routine` or
`POST /api/routines` (as the New routine screen does), else the goal whose id its instruction names,
else the goal its firing first runs with `run_goal`. Never a goal its instruction only mentions. A routine made
before 0.3.3 (`goal_by_title`) is read from its instruction, by the goal's id or its whole title in
quotes. See `routineRunsGoal`.

Its tools are OpenBot's own code, so the server brings the saved list up to date with the running
release at every start, before it gives them out: a tool a release renames, rewords or adds reaches an
existing installation without anybody pressing Refresh. A start where nothing changed writes nothing.

The routine belongs to whoever asked for it and runs as them. See
[Who a routine runs as](#who-a-routine-runs-as).

## The 15-minute floor and the 20-enabled cap

A routine may fire at most every 15 minutes. The floor exists because a model can be talked into
anything a sentence can describe, including "every minute", and the floor is what a sentence cannot
talk its way past.

A person may have at most 20 routines switched on at once. The cap exists for the same reason as the
floor: a conversation is an easy place to accumulate standing work without noticing, and 20 is where a
person's own list stops being something they can hold in their head. Switching one off frees a slot;
deleting one is not required.

## The fatigue rule

A routine that fails posts exactly one message about it — the first failure after a success, not
every failure. Ten consecutive failures switch the routine off and post a second, final message
saying so; nothing further fires until a person turns it back on. Turning it back on starts the
count again: only failures since the routine was last switched on count toward the ten.

This is deliberately not a retry policy. A retry policy answers "did this one attempt make it through
a dispatch that failed for a moment" — a busy queue, a server that hiccuped — and that question is
already answered by the shared work queue's own attempt count, quietly, before a routine's turn ever
runs. The fatigue rule answers a different question: is this routine worth firing at all. A Notion
token that expired in March fails cleanly, once, every single night, and no number of retries of any
one night's attempt will fix that — only switching it off, and saying so, does.

## Missed windows are skipped, not replayed

A routine's next run is a stamp, not a queue. If nothing was watching the clock (a deployment
that was stopped for a month), a routine's stamp falls behind, and the deployment
does not owe it every occurrence it missed: catching up is a silent drain, not a burst. A deployment
that comes back after a quiet month drains that backlog by advancing the stamp forward without
firing anything for it, occurrence by occurrence, until it is current again — not by firing thirty
stale summaries of thirty different mornings.

A firing that is still recent enough to be worth having does still happen. A server pod that restarts
loses at most the one occurrence that was in flight when it stopped; the next one fires on schedule,
because the clock had already moved on before that firing was attempted. A server that stays down
loses more than that: every occurrence whose stamp ages past the grace window while nothing can
carry it out is skipped, not just the one that was in flight.

## What fires them

The server does. It sweeps for due routines itself, inside its own process, alongside the rest of
its scheduled work (cleaning up unsent attachments, suspending idle computers), so a deployment
needs nothing beside the server for a routine to fire. `scripts/start.sh` starts no worker and
OpenBot Desktop runs none. (`docker-compose.yml` still defines a `worker` service for one release,
which nothing starts and which does nothing if started: an OpenBot Desktop app from the release
before reads a Compose file as current only when it defines one.)

It used to take a second process: a worker that ran the sweep in a loop and handed each due run to
the server at `/internal/routines/run`. A deployment that never started one stored every routine,
showed it with a next run time, and fired nothing, so the Routines page carried a warning for it.
With the sweep in the server there is no such state to warn about, and the page no longer does.
`GET /api/routines` still answers with the `sweep` record that warning read, for apps from before
this.

Each sweep still records that it happened, in `routine_sweeps`. The window that matters is
`MINIMUM_INTERVAL_MS`: fifteen minutes, the floor a routine's own schedule already has, so a gap
longer than that is one no routine could have wanted.

Two settings belong to the separate worker, and matter only to a deployment that still runs one
beside the server:

- **`WORKER_SHARED_SECRET`**: the credential a worker presents to `/internal/routines/run`. The API
  server refuses every handoff without it configured on both sides.
- **`SERVER_INTERNAL_URL`**: where a worker reaches this deployment's own API server.

That includes an OpenBot Desktop installation whose Compose file is a release's up to 1.0.3, which
runs the sweep in its `worker` service: Desktop reads the installed file, so it still starts,
restarts and stops that worker with the server, and removes its container once an update puts in
place a Compose file that says its server does the work (see [Desktop updates](desktop-updates.md)).

## Who a routine runs as

A routine runs as the person who created it, not as the Bot and not as an administrator. Its turn is
built with that person's own grants, so it can do in the middle of the night exactly what they could
do by typing the same instruction in chat themselves, and nothing more — a routine cannot reach a
connector its creator never connected, or post into a channel they are not in. Its reply is posted
into the channel as an ordinary message from that Bot: it lights the recipients' unread dot the same
way any other Bot message does, and it appears in the conversation transcript rather than anywhere
separate, because as far as the channel is concerned, that is exactly what it is.

## Scope

This ships the core: creating, listing, changing and deleting routines from chat; the schedule, the
cap and the fatigue rule; the sweep that fires them. Four follow-ups were listed in
[#193](https://github.com/CopilotKit/OpenBot/issues/193), which is now closed; the first of them has
been built. Audit rows now say what started the run they came out of, so a
routine's action is told apart from the same person's own by reading the row rather than by
correlating timestamps against `routine_runs`. See [Architecture](architecture.md#what-started-a-run). Still open:
there is no admin view of
other people's routines, only the owner-scoped page each person sees for their own; there is no
per-deployment or per-Bot cap on how many routines may be running at once beyond the sweep's own claim
limit; and a tenant package cannot yet ship routines the way it ships agents, channels or skills.

## See also

- [Architecture](architecture.md) — where the routines sweep sits beside the computer culler on the
  shared work queue.
- [Coworkers](coworkers.md) — durable Bot profiles and channels, which a routine posts into.
- [Configuration](configuration.md): `WORKER_SHARED_SECRET`, `SERVER_INTERNAL_URL`, for a deployment that still runs a separate worker.
