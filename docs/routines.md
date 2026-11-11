# Routines

A routine is a standing instruction: something a Bot carries out on a schedule instead of waiting to
be asked. "Every weekday at nine, summarize what changed in this channel overnight" is a routine, not
a message — it fires on its own, for as long as it stays switched on, and its reply lands in a channel
the same way any other message from that Bot does.

## Creating one

Two ways, and they write through the same store call.

- **Routines in the sidebar.** The Routines page lists every routine you have, across all your Bots,
  and **New routine** opens a form: the Bot, what it should do, when (every day, every weekday, one
  day a week, one day a month, or every hour, at a time on your clock), and the conversation it posts
  in, or a new one named after it. A Bot's own Routines page and the clock beside a conversation's
  message box open the same form with that Bot, and that conversation, already chosen. The form
  sends `POST /api/routines`, which calls `routineStore.create` exactly as `create_routine` does.
- **Ask a Bot**, in a conversation: "every weekday at 9, post the standup notes here." Anything the
  form's schedules do not cover ("every other Tuesday") goes this way. The same Bot can list what is
  standing, change one, or delete one, all by being asked. There is no edit form.

Connections > Routines points to the Routines page, and the New Bot form shows an example beside
Routines under "Apps it can use".

**Always on.** Every Bot can do this, in every edition. The server adds Routines at startup and gives
every Bot all of its tools, including the write tools `create_routine`, `update_routine` and
`delete_routine`. A Bot made later gets them the first time it runs. Routines can't be turned off, and
its tools can't be taken from a Bot: the server answers `403`. A Bot still asks before each write
while Extra vigilant is on, and before `delete_routine` always (see
[Approvals](approvals.md)). See `server/src/plugins/personal-defaults.ts`.

**Goals too.** The same app carries a goal's tools for a conversation: `create_goal`, `list_goals`,
`update_goal`, `run_goal`, `pause_goal`, `resume_goal` and `complete_goal`, beside the trigger tools
that wake a goal. Asked for a goal, a Bot makes one that reports into the conversation it was asked
in, or into another the person names, and it shows on the Bot's Goals page. A goal has no schedule of
its own: it runs when asked, or when an event wakes it. A goal's own run is not given these copies,
because it already holds the goal's own tools. See `server/src/responsibilities/chat-tools.ts`.

A goal that repeats is never completed by one of its runs. It repeats when it was made `recurring`,
when an enabled routine of its Bot runs it, or when an event wakes it. Its run is told so, records
its result with `report_goal_progress`, and is refused `complete_goal`; only the person ends it.
Asked to run a completed or paused goal, `run_goal` says so instead of running nothing. See
`GoalRepeats` in `server/src/responsibilities/types.ts`.

A routine records the goal it runs (`routines.goal_id`): the `goalId` a Bot passes to
`create_routine` or `update_routine`, else the goal whose id its instruction names, else the goal
its firing first runs with `run_goal`. Never a goal its instruction only mentions. A routine made
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

A routine's next run is a stamp, not a queue. If nothing was watching the clock — a worker that was
never started, or one that was down for a month — a routine's stamp falls behind, and the deployment
does not owe it every occurrence it missed: catching up is a silent drain, not a burst. A deployment
whose worker comes back after a quiet month drains that backlog by advancing the stamp forward without
firing anything for it, occurrence by occurrence, until it is current again — not by firing thirty
stale summaries of thirty different mornings.

A firing that is still recent enough to be worth having does still happen. A server pod that restarts
loses at most the one occurrence that was in flight when it stopped; the next one fires on schedule,
because the clock had already moved on before that firing was attempted. A server that stays down
loses more than that: every occurrence whose stamp ages past the grace window while nothing can
carry it out is skipped, not just the one that was in flight.

## The worker requirement

Nothing above happens without a second process. The API server answers `/internal/routines/run` when
it is handed a run, but nothing hands it one on its own — that is a separate worker's whole job, and a
deployment that never started one schedules nothing.

This used to fail silently. A routine created in chat is stored, its schedule is computed, and the
Routines page shows it sitting there with a next run time like any other — because as far as that
page knows, it is correct. A deployment with no worker looked identical to one running normally,
right up until nobody's standup notes ever arrive.

Each sweep now records that it happened, in `routine_sweeps`, and the Routines page reads it. A
person with standing routines and nothing sweeping is told so: that no worker has ever checked in,
or when the last one did. The window is `MINIMUM_INTERVAL_MS` — fifteen minutes, the floor a
routine's own schedule already has, so a gap longer than that is one no routine could have wanted.
A CronJob scheduled less often than that will read as quiet between runs.

Two settings carry this:

- **`WORKER_SHARED_SECRET`** — the credential the worker presents to `/internal/routines/run`. The API
  server refuses every handoff without it configured on both sides, and the worker refuses to start
  without it at all, rather than firing routines nobody could ever prove came from it.
- **`SERVER_INTERNAL_URL`** — where the worker reaches this deployment's own API server. It is a fact
  about where the worker process runs rather than a fact about the deployment, so it is read from the
  environment directly rather than from the rest of the deployment's configuration.

On Kubernetes, the chart runs a CronJob of `fire-routines.ts` on `routines.schedule`, on by default
(`routines.enabled`), and generates the shared secret for it and the API server unless one is
supplied (see [the chart's routines sweep](../charts/openbot/README.md#the-routines-sweep)). It is a
CronJob the same way the computer culler is a CronJob rather than a timer inside the API: a timer fires in
every replica, and a CronJob's single run does the whole sweep once. On a laptop, `scripts/start.sh`
starts a worker process that runs that same sweep in a loop instead of once and exiting, so the two
shapes are the same code doing the same thing on two different clocks, not two implementations to keep
in sync.

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
cap and the fatigue rule; the worker that fires them. Four follow-ups were listed in
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
- [Configuration](configuration.md) — `WORKER_SHARED_SECRET`, `SERVER_INTERNAL_URL`.
