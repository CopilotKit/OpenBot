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

**Routines in the main menu is a box and the routines grouped by Bot.** Under its heading sits one
box (`RoutineBox`): say what a Bot should do and when in a sentence, and press Send or Enter. It is
a taller rectangle, a few lines high, and it is Home's message box with only its `@` menu. Name the
Bot with **@**; with no @, OpenBot picks the Bot as Home does (see [The box](#the-box)). Below the
box are the person's routines, goals and check-ins in one group per Bot (`BotGroupSection`). A page
with no routine on it also offers three example sentences; pressing one only types it into the box.
The page has no title row and no New routine button: the box is how a routine is made. If one of
the reads fails, the groups that did load stay and a line above them says which part is missing
("Couldn't load your goals").

A group is the Bot's orb, its name (a link to that Bot's own Routines page) and how many rows it has.
Bots you have hidden come after the ones you haven't, and a Bot a row names that no list knows is
drawn as "A Bot", without a link. A Bot that is in both lists for a moment after being hidden or
unhidden is one group, in the shown position (`routinesByBot`, `app/src/lib/routines/by-bot.ts`).
A Bot with nothing to show has no group.

Each row is one line: an icon (a clock for a routine, a target for a goal, an eye for a check-in; a
spinner while it is running, a pause mark while it is off), its name, and **one fact** about it. The
fact is the first of these that applies (`rowFact`):

1. **Running now**, while it is working: a run that has started and not finished, or for a goal, one
   of the routines that run it; for a check-in, while it is checking.
2. **What went wrong last time**, in amber: a failed or skipped run, "Its conversation was deleted",
   or "Couldn't check last time" for a check-in. A goal has none of its own.
3. **Paused**, or for a goal **Completed**, dimmed.
4. **When it starts**: a routine's schedule (with its time zone when that is not the reader's), a
   goal's starts in words, or "Checks" and how often for a check-in.

Inside a group the rows run in five bands (`band`), and a tie keeps the order the lists came in:

1. Running.
2. Warning.
3. On and with a next start, soonest first. For a goal, its soonest enabled routine.
4. On with no start: a goal that only runs when asked or when an event wakes it.
5. Off: paused, or a goal that is completed.

A row opens the record it came from: `/routines/schedules/<id>`, `/routines/goals/<id>` or
`/routines/check-ins/<id>`.

A Bot's own Routines page keeps its rows, every one the same sentence in four parts:

- **What** it is: the routine's instruction, the goal's title, or the Bot's check-in.
- **Starts**: a routine's schedule; for a goal, the routines that run it and the events that wake
  it, or when you ask; for a check-in, at most once an hour.
- **Does**: whether it acts, or only tells you.
- **Until**: until you stop it, or, for a goal, the outcome that completes it.

A routine that runs a goal is not a row of its own: it is one of that goal's starts, so the goal's
row carries it. Rows that are working (on, active, not paused) come first. The switch for check-ins
from all your Bots is not on Routines: it is **Check-ins**, the first section of Settings →
Notifications (`CheckInsSection`), in every edition. In the team edition an admin turns check-ins
on or off for everybody, and limits them, in Admin → Routines.

Old addresses redirect here: `/responsibilities` to Routines, and
`/bots/<id>/responsibilities` to the Bot's Routines page.

## Creating one

Three ways, and either of the first two writes a routine or a goal with the same store calls.

- **The box**, on Routines in the main menu. See [The box](#the-box).
- **New routine.** A Bot's Routines page has **New routine**, and the box's **Finish** opens it
  when a sentence needs more; either opens one screen (`/routines/new`). It asks, in order: **Bot**,
  **What to do**, **It should** (Act for you or Only tell you), **Starts** (On a schedule, When
  something happens, or Now, once), **Done when** (optional), **Posts in**, and **Name**. It does
  not ask whether you want a routine, a goal or a check-in; the answers decide: `planRoutine`
  (`app/src/lib/routines/plan.ts`) turns them into a plan, and `createFromPlanMutationOptions`
  writes it:
  - Act on a schedule with nothing in Done when is a routine
    (`POST /api/v2/organizations/{organizationId}/routines`, which writes it exactly as
    `create_routine` does).
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

### The box

The box makes what the sentence says, or says in a line under it why it didn't. Nothing is written
until the server has read the sentence and the answers pass the form's own rules.

**The Bot.** There is no Bot picker. The box is Home's message box (`Composer`) with only its `@`
menu and no `/` skills; `@` lists your Bots, one per sentence, as a chip, and the sentence sent to
the read is the words without the chip. A sentence with no @ goes to the Bot OpenBot picks, as it
does on Home (`pickBotFor` with `routeMessage`, falling back to the default Bot the same way), and
the line then names the Bot that took it, so a wrong pick shows. When two Bots share the name the
sentence used, routing refuses, and the line says so in its own words and keeps the sentence.

**The read.** The box sends the Bot, the sentence (at most 2,000 characters) and the browser's time
zone to `readRoutineSentence` (`POST /api/v2/organizations/{organizationId}/routines/read`, in
`api/openapi/schedules.yaml`). It is a read: it **writes nothing**. It asks the model to put the
sentence into the same answers as New routine (What to do, a name, It should, Starts, the schedule as
five cron fields, Done when, Posts in, How often, a time zone) and says which of four things came
back, in `outcome`:

- `ready`: the answers are complete.
- `needsMore`: a routine, with something left out. `missing` is `time`, `event` or `once`.
- `refused`: the sentence asks for something a routine can't do. `detail` is the sentence for the
  person, and `fix` is `connectApp` or null.
- `notRoutine`: the sentence isn't a request for one.

A repeated request with the same `Idempotency-Key` and body returns the first reading without asking
the model again. A web session, an API key, or an app with `routines:read` may call it.

**What it makes.** A ready reading goes through `planRoutine` and `createFromPlanMutationOptions`,
the two calls New routine makes, so the same rules decide what kind of thing it is:

- A sentence that acts on a schedule is a **routine**.
- One that acts on a schedule toward an outcome ("until the contract is signed") is a **goal on a
  schedule**: a goal that ends when met, with **Done when** the outcome, and a routine that runs it.
- One that only tells you is a **check-in**, with how often it checks.

The schedule and time zone the sentence gave are written as given, so "every other Tuesday" or "9am
Eastern" is not turned into the picker's nearest shape. When the Bot is not told where to post, a new
conversation is made and named after the routine, as the form does. The line then says "*Bot* took
"*name*" · *when it starts*", with when it starts in the words its row uses ("Weekdays at 09:00",
with the time zone when it isn't the reader's), read from what the server made. It offers **Open**,
which goes to the new routine, goal or check-in, and **Undo**.

**Undo** deletes what was just made: the routine; a goal and the routine that runs it; or the
check-in (`undoMadeMutationOptions`). The line then reads "Removed." Undo is offered only on that
line; later, a routine is deleted from its own page as before.

No line has a close button. A line goes when the next sentence is sent or the page is left.

**What it sends to the form.** When the sentence is a routine but isn't enough to make one, the line
says what is missing in the Bot's words and **Finish** opens New routine with the answers so far and
the Bot already chosen:

- **No when**: "*Bot* needs to know when for "*name*"".
- **An event**: it starts when something happens, and the sentence didn't say which: "*Bot* needs to
  know which event starts "*name*"".
- **Now, once**: the sentence is something to do once, at once, which the form does and the box
  doesn't: ""*name*" is something to do once, now. Finish it on the form."

A sentence that isn't a routine ("Couldn't read that as a routine.") and one the server couldn't read
at all (no model set up, or no answer) are said in a line with no action. **Finish** stays only for
a sentence that needs a time, an event or a once-only start. Answers that break one of the form's
own rules are refused in the line; the rules are the form's (`brokenRules`,
`app/src/lib/routines/rules.ts`), so the box and the form refuse the same things.

**The refusals.** The line is amber, says why, and keeps the sentence in the box so it can be
changed. The server refuses, each in a sentence of its own, what a routine can't do: running more
often than every 15 minutes, a check-in that looks other than every hour, every 4 hours, twice a day
or once a day, a web page to watch, something once at a set time ("tomorrow at 9"), a schedule five
cron fields can't say, an app the Bot can't read, and a check-in for a Bot that can't read any of
your apps yet. The last two come with **Connect**, which opens Connections. It never moves a
sentence to the nearest thing allowed, because a moved time is a guessed time. The box refuses two
more before it writes anything: an admin has turned check-ins off ("Your admin turned check-ins
off, so *Bot* can only act for you."), and the Bot already has a check-in on that subject ("*Bot*
already checks in on "*subject*"."). The 20-enabled cap and the 15-minute floor
(see below) still apply at the write, and so does taking back a goal whose schedule is refused. A
write that fails says why and keeps the sentence. A write that may have been saved (its answer never
came back, or a goal whose schedule was refused could not be taken back) says "It may have been
made. Check the list before sending it again.", clears the sentence, and sends nothing a second
time.

Connections > Routines points to the Routines page, and the New Bot form shows an example beside
Routines under "Apps it can use".

**Always on.** Every Bot can do this, in every edition. The server adds Routines at startup and gives
every Bot all of its tools, including the write tools `create_routine`, `update_routine` and
`delete_routine`. A Bot made later gets them the first time it runs. Routines can't be turned off, and
its tools can't be taken from a Bot: the server answers `403`. A Bot still asks before each write
while Extra vigilant is on, and `delete_routine` asks as any delete does, unless the person allowed
it for the conversation or always (see [Approvals](approvals.md)).

**Goals too.** The same app carries a goal's tools for a conversation: `create_goal`, `list_goals`,
`update_goal`, `run_goal`, `pause_goal`, `resume_goal` and `complete_goal`, beside the trigger tools
that wake a goal. Asked for a goal, a Bot makes one that reports into the conversation it was asked
in, or into another the person names, and it shows on the Bot's Routines page. A goal has no schedule of
its own: it runs when asked, or when an event wakes it. A goal's own run is not given these copies,
because it already holds the goal's own tools.

A goal that repeats is never completed by one of its runs. It repeats when it was made `recurring`,
or, unless it was made `endsWhenMet`, when an enabled routine of its Bot runs it or an event wakes
it. Its run is told so, records its result with `report_goal_progress`, and is refused
`complete_goal`; only the person ends it. Asked to run a completed or paused goal, `run_goal` says
so instead of running nothing.

A goal that a routine or an event starts can still be completed by a run that meets its outcome, when
it is made `endsWhenMet`; without it, a goal a routine or an event starts repeats and a run never
completes it. It never combines with `recurring`: the
store and `parseResponsibilityInput` refuse both together. Completing a goal by any path, a run or
the person, switches off the routines that run it (`routineRunsGoal`): those whose `goal_id` is that
goal, and an older routine that names it by id or whole quoted title. An older routine that also
names another goal of its Bot that is not completed stays on, so that goal still repeats; it is
switched off when the last goal it runs completes (`switchOffRoutinesOf`). A goal made on the New routine
screen may have no success criteria, and its run is then told the outcome is that the instruction has
been carried out (`NO_OUTCOME` in `shared/responsibility-turn.ts`); a Bot's `create_goal` still
requires them.

A routine records the goal it runs (`routines.goal_id`): the `goalId` passed to `create_routine`, `update_routine` or
`POST /api/v2/organizations/{organizationId}/routines` (as the New routine screen does), else the goal whose id its instruction names,
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

Where several servers run against one database, one of them at a time decides which routines are
due: the one holding a PostgreSQL advisory lock, which looks every 30 seconds. Every server runs
the turns, claiming five at a time, so one server does not carry every routine in the deployment. Each
server checks the lock every five seconds, so when the one that held it stops, another takes over
at its next check. A firing is still claimed from the shared work queue under a key naming the
minute it was due, so two servers that both believe they lead for a moment cannot fire it twice.

It used to take a second process: a worker that ran the sweep in a loop and handed each due run to
the server at `/internal/routines/run`. A deployment that never started one stored every routine,
showed it with a next run time, and fired nothing, so the Routines page carried a warning for it.
With the sweep in the server there is no such state to warn about, and the page no longer does.
The routines list (`GET /api/v2/organizations/{organizationId}/routines`) carries no record of the
sweep.

A sweep no longer records that it happened: nothing writes `routine_sweeps` now, and the table
stays for one more release.

The server has no `/internal/routines/run` now and reads neither of the two settings that worker
took: `WORKER_SHARED_SECRET`, the credential it presented there, and `SERVER_INTERNAL_URL`, where it
reached the server. Neither is in `.env.example`, and a line for either left in an existing `.env`
does nothing.

The one place a worker still runs is an OpenBot Desktop installation whose Compose file is a
release's up to 1.0.3, which runs the sweep in its `worker` service: Desktop reads the installed
file, so it still starts, restarts and stops that worker with the server, and removes its container
once an update puts in place a Compose file that says its server does the work (see
[Desktop updates](desktop-updates.md)). Desktop supplies both settings for it.

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
