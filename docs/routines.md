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

**What a check-in reads.** Every check-in records what it reads (`proactive_settings.source_kind`):
every app you connected with your own account that its Bot can read (`apps`, what New routine's
**Your connected apps** makes and what every check-in made before this reads), one of those apps
(`app`, named in `source_server_id`, what accepting a Bot's offer about something in that app
makes), or one public web page (`page`, at `source_link`). A check-in on one app is offered that
app's reads and no other app's. The server works the kind out itself: from the tool the Bot read
the thing with (`readWith`, which the offer card sends back), or from New routine's **It watches**,
never from a label. A Bot's offer on something it read another way (its browser, the computer, a
Shared app, an app on the admin's key) is answered "Nothing to offer", and no card is drawn.

**A check-in that could never look is not made.** Creating one is refused, with the sentence the
person reads, when its Bot can read no app they connected, can't read the app it was offered on,
holds no tool that reads a web page, or the page's address isn't a public `http(s)` one. New routine
asks the same of `GET /api/proactive/readable?agentId=` and says it on It watches before Create.
A check-in the person makes is due at once, so its row says how its first look went within a
minute. Rows adopted with `OPENBOT_PROACTIVE_DEFAULTS` keep their delay.

**When one stops being able to look, it says so.** `GET /api/proactive/settings` gives each check-in
a `health`: null, or why it can't look and the step that fixes it (connect an app, open an app's
page or the check-in, or remove it). It can't look when its Bot can read no app you connected, the
app it reads isn't connected, its Bot has no web search for its page, the Bot is no longer yours to
use, or its last three check-ins failed. Paused, off, over the daily limit and busy are not this.
The first four are asked afresh (kept for a minute), so the row clears once the app is connected;
three failures clear when the next check-in finishes. It shows on the check-in's row (which sorts
first), as the first row of its Bot's group under Needs you (not counted in the Bots badge, but the
badge's dot shows), and on its page above On. No ping is sent for it. Each row also says what it
reads: "Reads Gmail", "Reads your apps", "Reads github.com".

### Pause all

Routines' every-Bot card starts with **All Bots active**, the person's own switch for all their Bots
(both editions; an admin has no team-wide one). Off, every one of their Bots behaves exactly as a
paused Bot does: no routine, goal, check-in, hand-off or follow-up starts, headless turns already
running are stopped, and a Bot doesn't answer their Slack, Teams or text messages, take its turn in
a group conversation or carry on after an approval. It still answers in a one-to-one conversation in
the app. Work on it is refused up front, with no task made, while its Bot is paused by itself or
with all.

It is kept on the person (`users.preferences.pausedAllAt`), and `readPause` in
`server/src/agents/lifecycle.ts` answers paused when the Bot is paused or the person paused all, so
every caller of `isBotPaused` and `guardBotTurn` honours it, a Bot made meanwhile is paused too, and
an unreadable answer is paused. Each Bot's own pause is untouched: turning it back on returns every
Bot to the state it had. Routines and goals record "The Bot is paused, so it did not run." The
check-in sweep claims none of the person's check-ins, and Run now answers `paused_all`, "You paused
all your Bots." `PUT /api/bots/pause-all` with `{ paused }` writes it; `GET /api/bots/attention`
answers `pausedAll`. While it is off, Bots, Routines and each Bot's page show "All your Bots are
paused." with **Resume all**, and check-in rows read "Paused". In the OpenDots skin it is the top
bar's pause control.

### Watching a web page

A `page` check-in reads one address and nothing else, and the model is given no tool that takes an
address. Each run, after the usual gates, the engine reads `source_link` itself through the Bot's
page-read tool (Parallel's `web_fetch`, Exa's `web_fetch_exa` or Firecrawl's `firecrawl_scrape`), by
`PluginStore.callTool` as the person and under the run's proactive initiator, so grants, policy and
the audit trail apply as to any call. The text is normalised, capped at 50,000 characters and
hashed, and kept on the check-in (`page_text`, `page_hash`):

- the first read is kept as the baseline, and nothing is raised;
- the same page again ends quiet, with no model call;
- a changed page runs one turn, given the earlier and the new text as quoted, untrusted data, whose
  only tools are `suggest_next_step` and `clear_next_step`. What it raises takes the page as its
  source: its host as the app and its address as the link. The new text becomes the baseline once
  that turn finishes;
- a read that fails ends failed, "Couldn't read the page."; three in a row is can't look.

A page run forms no memories and its thread is given no Learning container: text from the open web
never becomes something a Bot knows about the person. Each run counts toward the Bot's daily limit,
changed or not. The address is fixed when the check-in is made; changing it means making a new one.

**The door.** A check-in's tool call is refused unless it is a labelled read on the person's own
account, and a page read is neither, so `callTool` admits one more call: a page-read tool
(`researchRoleFor(ref) === "fetch"`), from a running check-in whose kind is `page`, asking for exactly
that check-in's address. Anything else (another address, two addresses, a search tool, a page read
from a check-in on apps) is refused and audited as `check_in_not_a_read`. This covers the keyed
entries as well, on the admin's key: the admin gave the Bot the tool, the page is public, and the
daily limit bounds how often a Bot reads it for one person. The address check when it is made
(`http` or `https`, not a loopback or private host) is a courtesy: the read happens at the provider.

A check-in on a web page made before check-ins knew pages reads every app, and stays that way until
the person accepts a new offer on the same link, which makes it a `page` one.

**A check-in belongs to its Bot.** It posts nowhere and needs no conversation: what it finds is
raised under Needs you, and a ping's phone push is filed under its Bot. It runs while you can still
use that Bot; when you can't, its runs are skipped with "This Bot is no longer available to you."
Check-ins made before this were tied to a conversation (`proactive_settings.channel_id`). Those
conversations are left as they are, and deleting one no longer affects the check-in.

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
    only while an admin allows check-ins. It has no **Posts in** and no conversation is made for
    it: a check-in belongs to its Bot, and what it finds shows under Needs you on Bots.

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
in sync. OpenBot Desktop runs the same loop as the `worker` Compose service, from the server image,
behind the `openbot` profile in `docker-compose.yml`.

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
