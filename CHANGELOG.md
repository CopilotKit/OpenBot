# Changelog

What changed, for somebody deciding whether to upgrade. Written for the person running OpenBot, not
for the person who wrote the commit: a line belongs here when a deployment behaves differently
afterwards, and does not when only the code moved.

Newest first. `Unreleased` is what is on `main` and not yet tagged.

## Unreleased

### People and Bots can use their own avatars

The signed-in person can upload, replace, or remove a PNG, JPEG, or WebP avatar from Settings. Bot
owners can do the same from the coworker dialog, and deployment administrators can brand packaged
Bots without gaining permission to rewrite their executable profiles. Custom images now follow the
person or Bot through the sidebar, channel roster, recipients, handoffs, and profile surfaces, while
removal returns to the identity-provider image, initials, or generated Bot avatar.

Uploads are authenticated, limited to 2 MB and safe image dimensions, checked against their actual
file signature, and served from short private versioned URLs rather than copied into roster JSON.

### Computer use is a whole graphical computer, with a dock that survives closing the browser

A Bot with an isolated computer now exposes its full Linux desktop through the guarded OpenBot
screen: browser chrome, tabs, native dialogs, a terminal, and the desktop itself rather than only a
CDP canvas of one page. The small dock contains exactly the applications the image provides — the
managed Browser and a Terminal in the durable workspace. Closing Chromium with its own **X** leaves
the desktop running, records that the browser closed, and the Browser icon opens the same Bot profile
again instead of leaving the computer in a dead state. Non-default desktop sizes are letterboxed
rather than stretched.

The full framebuffer is offered only by a per-Bot provider. A shared computer keeps the Bot-scoped
page stream, because its process-wide desktop could expose another Bot's window. Kubernetes
`computers.mode: sandbox` gives each Bot its own container; `vm` requires the configured Kata runtime
class for the VM boundary. Older computer images also fall back to the page stream during a rolling
upgrade. The chart is now 0.2.0, and release automation keeps its default `appVersion` on the exact
OpenBot image being published.

Watching remains read-only. Taking control now returns a random, short-lived capability held only by
that browser tab; the computer checks it again on the WebSocket and on every mouse or keyboard event.
A second authorized viewer can watch but cannot inject input, replace the first person's takeover, or
reuse the public “human is driving” state as permission. Closing the tab lets the lease expire and
returns the wheel to the Bot.

### A local Codex coworker keeps its conversation and uses OpenBot's governed tools

OpenBot can now run a coworker through the Codex app already signed in on the host, without an API
key. Its conversation survives adapter and app-server restarts: OpenBot records the Codex thread it
owns, resumes that exact thread, and refuses to silently replace unreadable recovery state.

Connector calls do not go around the deployment. Codex sees only the tools OpenBot assigned to that
coworker, and every call returns with the deployment's signed run assertion through the existing
grant, policy and audit gateway. Native Codex shell, file, web, browser, computer, app, plugin and MCP
paths are disabled before a turn can begin, the child process receives none of OpenBot's tool,
computer, database or provider credentials, and the remaining turn is sandboxed read-only without
network access. A post-start interruption remains as an alarm if a disabled native path is ever
reported. Rejected, stale and duplicate callbacks are reported as failed tool results rather than
being carried out.

### Coworkers are made in a wizard and managed in a dialog

Creating a coworker is now a three-step wizard — who it is, who may see it, then where it runs,
with **Built in** offered only when the deployment actually has a managed Bot to run it on.
Managing one is a dialog opened from wherever the coworker appears, with sections for its profile
(each field edited in place), what it may reach, its connection, handoff grants, routines, and the
hide/duplicate/delete verbs — usable on a phone, where the old side panel hid most of this. The
panel beside a conversation slims down to who-you-are-talking-to plus two buttons: start a new
channel, or open that dialog.

### Routines live on each coworker

The sidebar's global Routines entry is gone; a coworker's routines are a section of its own dialog,
since a routine is something *it* carries out. The `/routines` page still answers direct links.
Each routine row now wears its state as chips — the channel it posts to, how the last run went, and
either the next run, **Paused**, or **Due** when a firing is waiting on the sweep (which used to
render as "Next 5 hours ago").

### A built-in coworker is no longer asked for credentials it will never need

A coworker running on the deployment's own Bot was nagged for a callback token and shown an
endpoint form. Its connection tab now says what is true — it runs here, nothing to connect, nothing
to authenticate. In the same spirit, the handoff panel explains once when a coworker cannot hand
work on (it runs as its own agent, outside this deployment's loop) instead of offering switches the
server can only refuse; its existing grants stay visible so they can still be revoked.

### A channel stops showing a working indicator once its turn has ended

Sending a message and then opening another channel before the reply arrived left the first channel
showing three bouncing dots on the roster, and they stayed there after the answer had landed and
been drawn into its preview, until the roster was refetched for some unrelated reason. A person's
own turn is reported by the browser, because the server is not told when one begins, and that
reporting was keyed on state belonging to the channel screen: opening another channel replaced the
screen, and the replacement reported the channel it had just opened rather than the one still
working. The report now belongs to the turn instead of to the screen, so the channel that was
running is the channel told when it stops. Opening a channel also no longer announces that it is
idle twice before anything has run in it.

### A hop the boundary refused now names the Bot that was refused

The audit page renders its Bot column from `payload.bot` and nothing else. `agent.handoff_offered`
and `agent.handoff_delivered` were given that key; the four rows either side of them — a hop
refused, a hop retried, and a hop that failed for good — were not, so they showed a dash where the
Bot belongs. Those are the rows somebody actually opens the trail for: a hop that happened is visible
in the transcript anyway, and a refused or lost one is visible nowhere else. All four now name the
asking Bot, exactly as the accepted pair and `agent.escalated` already did.

### A failed tool refresh no longer leaves a connector offering nothing

Refreshing a connector's tools replaced the list with a delete and then an insert, as two separate
statements. Whenever the second did not land — a pod killed mid-refresh, a dropped connection, or a
server answering `tools/list` with the same tool name twice, which the table refuses — the delete had
already committed on its own. The table is shared, so every replica lost that connector's tools at
once, every grant an administrator had made was silently un-offered, and the Bot was told it holds
none of that vendor's tools. Nothing brought them back until somebody read the error on the Plugins
page and pressed Refresh. The two statements are now one, so a bad refresh is recorded and the tools
already held are left alone, which is what the code always claimed to do.

### A rule tried in dry-run now says what it would have refused a Bot's tools

`dry-run` exists so a boundary can be measured against live traffic before it starts refusing
anybody. It worked that way for the browser, and not for connectors: a tool call the rule matched was
recorded only as the call that then went out, so `Blocked` on the audit page — and any query behind
it — answered "this rule would have refused none of them" about calls it would have refused. A rule
about `mcp.server`, `mcp.tool` or `mcp.effect` therefore looked inert, and enforcing it started
refusing Bots with nothing in the trail to have warned anybody. A refused tool call is now recorded
whatever the mode does with it, carrying `carriedOut` so a reader can tell a call this deployment
stopped from one dry-run recorded and let past. Enforcing deployments behave exactly as before.

### A policy dry-run no longer counts a failed action twice, or invents a change it did not make

Testing a boundary against recent history replayed three kinds of audit row, and one of them is a
duplicate: a permitted action that fails is recorded both as the decision that allowed it and as a
separate failure row, so every failed action was scanned and scored twice. Worse, a dry-run policy
carries a refused action out, so a refused action can fail too — and its two rows disagree, the
decision row saying "refused" and the failure row reading as "allowed", so a candidate policy that
refused it identically was reported as a new refusal it never introduced. The replay now scores each
action once, from the row that recorded its decision.

### A message no longer routes to a specialist because a longer word contained a connector's name

When the intent router falls back — it is unreachable, or it declines — and exactly one coworker can
reach a system the message names, the message goes to that coworker. The name was matched as a bare
substring, so "how do I deal with a slacker" matched the **slack** connector and "una jirafa" (a
giraffe) matched **jira**: a message naming neither system was pinned, for the life of the thread,
to a specialist that could not answer it. A connector's name now has to appear on a word boundary,
so a system named on its own still routes and one buried inside another word does not.

### The audit page no longer says "Allowed" about six kinds of refusal

A hop one Bot was not allowed to make, an endpoint this deployment would not dial, a rotation the
vault refused and a sign-in it turned away were all drawn as **Allowed**, in the muted colour every
ordinary row uses, and none of them appeared under **Blocked**. The same for a hop that ran out of
attempts and a question that reached nobody, which are "Did not happen" rather than allowed. The
page recognised six refusal types and the six added since were never added to it. Refusals now read
as refusals, the two saved views are built from the same lists the rows are labelled from, and a
refusal added later is added in one place or in none.

### A conversation deleted while a server was reconnecting no longer lingers on the screen

Announcements between servers travel as Postgres notifications, which reach whoever is subscribed at
the moment they are sent and are never replayed. While a server's subscription was down — a database
restart, a failover, a rolling upgrade — every channel deletion, pin and message announced in that
window was lost, and nothing afterwards asked for it again.

The browser could not notice. Its own connection to the server stayed open throughout, so the
refetch it already does when that connection comes back was never triggered, and the roster went on
showing a conversation that had been deleted until the page was reloaded.

A server now tells the browsers it is holding to refetch when its subscription is re-established.
Nothing to configure, and no change for a deployment whose database connection never drops.

### A Bot's answer comes back to the conversation that asked

**This reverses what 0.0.5 shipped.** The 0.0.5 notes below say the asking Bot does not relay text
on the addressed Bot's behalf, and the answer lands in that Bot's own conversation. In practice
that meant reading the answer somewhere you never asked anything, so it is now the other way
around: the addressed Bot works in a scratch conversation nobody is shown, and the asking Bot
relays what came back — attributed by name — into the conversation you are watching. What you read
is the asking Bot's account of the answer rather than the answer verbatim; very long answers are
clipped to keep the relay itself from failing.

### Channels say when a Bot is working in them

A channel whose Bot is mid-turn shows a working indicator on its roster avatar — including turns no
browser started, such as a handoff running on the server or a routine. An open conversation also
picks up turns that arrived while nobody here streamed them, so a relayed answer appears without
leaving and coming back.

### First sign-in gets an onboarding wizard

A new person lands in a short welcome wizard before the app; everyone who signed in before this
upgrade is stamped as already onboarded by the migration and sees nothing.

### Shift+N starts a new chat from anywhere

Bound across the signed-in app, shown under **Settings → Keyboard shortcuts**, and inert while you
are typing in a field. Handoff work is also picked up the moment it is queued rather than at the
next poll, so an answer's round trip no longer pays up to two seconds per leg.

### A Bot's shell can no longer reach the embedded database without a password

In the all-in-one image the cluster was `trust`-auth on loopback, and the Bot's shell runs in the
same container: it could `psql -h 127.0.0.1 -U openbot` with no password and read the audit trail,
the policy store, and the credential vault as the instance owner. The cluster now uses
`scram-sha-256` with a password generated on first init and kept beside the data, handed to the API
over the container environment. The shell has no way to learn it, so the connection is refused. An
external `DATABASE_URL` deployment is unaffected.

### A live screen that ends says so, instead of freezing the last frame

When a Bot's live screen ended — the computer stopped, or the socket failed — the message explaining
why was drawn only by a component the take-the-wheel view does not mount, so the screen sat frozen on
its last frame with nothing said. The reason is now shown where the live screen is.

### A Bot's browser drops the automation flags a person needs gone to sign in

The browser announced itself as automated (`navigator.webdriver`, the enable-automation switch),
which sites like Google refuse even when a real person has taken the wheel. Those flags are now off
at the source — the browser flag, not a script that patches `navigator.webdriver` and leaves the
other tells. A headless build still reports `HeadlessChrome` in its user agent, which only running
headed under a virtual display removes; that heavier change is tracked separately.

### An empty model reply, or a run with no question, no longer ends in silence

Two failures on strict OpenAI-compatible providers (z.ai GLM, Anthropic): a follow-up run that
carried only tool deltas and no human turn was refused outright, and a reply with no text and no tool
call ended the run with nothing on screen. A run with no human turn now carries a neutral
continuation, and an empty reply ends on a visible line rather than in silence. OpenAI, which
tolerated both, is unchanged.

### Embedded PostgreSQL initialises on a platform volume, and says so when it cannot

`EMBEDDED_POSTGRES=on` could not create its cluster on a platform whose persistent volume is an ext4
mount — Railway, and by the same mechanism most others — and it failed differently depending on where
the volume was mounted. Neither of the two paths this repo suggested worked, and the two suggestions
disagreed with each other: `docs/deployment.md` said `/var/lib/postgresql/data`, the `Dockerfile`
comment said `/var/lib/postgresql`.

Mounted at the parent, the mount arrives owned by root, `data` is not in it, and the image's
build-time `chown` is hidden underneath — so `initdb`, which has already dropped to the `postgres`
user, cannot create the directory. `postgres-init` now creates and chowns it first, as root, which is
the only step in a position to. This also fixes the plain
`docker run -v openbot-data:/var/lib/postgresql` case, which relied entirely on that hidden chown.

Mounted directly on the data directory, the mount arrives holding a `lost+found`, and `initdb` will
not initialise into a directory with anything in it. **The documented mount is now the parent,
`/var/lib/postgresql`**, which leaves `data` an ordinary subdirectory — what PostgreSQL's own hint
asks for, and what the `Dockerfile` already said. A volume already mounted at
`/var/lib/postgresql/data` and working — a Docker named volume, which arrives empty rather than with a
`lost+found` — keeps working and needs no change.

**The failure said nothing useful.** `api` waits on `postgres` and `migrate`, so neither started, the
container came up anyway, the platform reported the deploy a success, and the public URL served a
persistent 502 with the real reason visible only in the container log. A data directory that holds no
cluster and is not empty is now refused with a sentence naming the mount to use instead.

Reported by [@jerelvelarde](https://github.com/CopilotKit/OpenBot/issues/269) with the container logs
for both mount paths, which is what made the two failure modes separable.

### A sign-in a site opens in a new window is shown, and can be clicked

A Bot's browser was bound to the page it launched with, and to nothing the site opened afterwards.
Anything arriving in a new window or tab was invisible on the live screen and unreachable by input,
so the popup sign-ins that a person takes the wheel to complete were exactly the ones they could not
complete. Worse than invisible: a click at the place the popup's button was drawn went to the page
underneath it, so a person trying to finish a sign-in could navigate the page the Bot was working on
without seeing either result.

The browser now follows the window the site opens, and returns to the opener when it closes, which is
what a sign-in popup does when it succeeds. A snapshot taken before the change of page is refused
afterwards with the same "take a new snapshot" it already gives after a navigation, so a stale ref
cannot act on the wrong document.

Nothing to configure.

### Stopping a Bot's computer stops it, and the person watching is told

A computer somebody stopped came back up on its own about a second later, and reset did the same. The
live screen kept a loop asking for the Bot's current page once a second, asking for a page is what
starts a browser, and nothing tore that loop down when the browser it was showing went away. The same
loop kept the browser marked recently used, so a Bot with somebody watching was also immune to the
idle timeout and came straight back after being closed to stay under the cap on running browsers.
Those last two never involved a request at all, so nothing on the stop path could have covered them.

Two smaller failures went with it. A person who reconnected, leaving their old window open, could
have that old window's typing land in the page the new one was watching, with nothing said to either.
And a window closed while the browser was still starting left a screencast and its loop behind for a
connection that had already gone.

The screen is now held per connection rather than per Bot, so closing one only ever ends its own, and
teardown hangs off the browser closing rather than off the two requests that ask for it. A viewer
whose screen ends is sent a message saying why, whether the computer stopped, was reset, or the
screen was taken over by another window.

Nothing to configure, and no change for a deployment where nobody watches a Bot work. **The app does
not yet show that message**: it arrives at the browser and is held in state the live screen does not
read, so a person still sees the last frame until they reopen the screen. That half is tracked
separately in #287.

## 0.0.5

### One Bot can hand work to another, and reach a person when no Bot will do

A Bot asked something it is not the right Bot for can now put the question to one that is. The
addressed Bot answers **as itself, in its own conversation**, with its own tools and its own
knowledge. The asking Bot does not relay text on its behalf, so what you read is the answer that
Bot actually gave rather than another Bot's summary of it. *(Reversed since: see Unreleased — the
answer is now relayed back into the conversation that asked.)* The asking conversation records
that the question was put and to whom. A Bot that judges no other Bot will do can instead reach
the person who asked it.

**No Bot may address any other until an administrator says so.** Which Bot may reach which is an
ordinary grant, made per Bot on that Bot's own screen under **Bots it may ask**, and a Bot with no
grant is told it cannot rather than quietly trying. The pair is directional: that list is who this
Bot may ask, not who may ask it, so letting two Bots ask each other is two switches. A Bot addressed
by a name two Bots answer to is refused and both are named, because picking one would be a guess
about which colleague a person meant.

Two ceilings, because a Bot deciding to ask another Bot is a Bot deciding to spend a run:
`BOT_HANDOFF_MAX_DEPTH` is how many Bots deep a chain may go and defaults to `1`, and **`0` switches
the capability off entirely**: the tool is not offered rather than offered and refused.
`BOT_HANDOFF_MAX_PER_RUN` is how many Bots one run may address and defaults to `3`. The Helm chart
takes the same two as `config.handoff.maxDepth` and `config.handoff.maxPerRun`.

A hop that fails is reported back by the Bot that asked, after its attempts are spent, rather than
leaving the person watching a conversation that never finishes. One rough edge to know about: a hop
that is retried leaves one "asked" line per attempt in the addressed Bot's own transcript, so a hop
that took three attempts reads there as having been asked three times.

No new tables: this uses the work queue that already fires the culler.

### A conversation that used a tool no longer stops answering for good

A channel could reach a state where every turn in it failed and the only thing it said was
`Tool result is missing for tool call call_…`. Not the turn: the conversation. Everything sent
afterwards failed the same way, including a question as ordinary as what two plus two is, and there
was nothing a person could do to it from the screen.

A tool result is matched to the call above it, and a thread read back from the platform does not
always carry the two in that order. Where the result was stored ahead of its own call, this
deployment counted the call answered, sent the history on unchanged, and the model provider rejected
the whole conversation while assembling it. Handing work to another Bot, asking a person, and
calling a connector's tool could each leave a thread in that shape.

A result now only answers a call it follows. One that arrives early is moved to sit after its call,
keeping what it actually said, and a result whose call is nowhere in the thread is dropped. Affected
conversations start answering again on their own; there is nothing to run and nothing to reset.

### The framework Bot answers on 5.6-tier models, and can be told how hard to think

Pointing `BOT_MODEL` at a `gpt-5.6-*` model gave a Bot that started, reported healthy, and then said
nothing: every run was a RUN_STARTED and a RUN_FINISHED with no text between them. Those models are
run on the Responses API, which streams content blocks where chat completions streams a string, and
the run read only the string — so every delta was dropped on the floor. Both shapes are read now.
Nothing changes for a deployment on 5.5 or on Anthropic or Google.

`BOT_REASONING_EFFORT` sets how hard a reasoning model thinks: `none`, `minimal`, `low`, `medium`,
`high`, `xhigh` or `max`. Unset, the model keeps its provider's default. A value the API does not
have, or one set where it cannot be sent — a provider that is not OpenAI, or a model not on the
Responses API — stops the Bot at startup with a message naming what to change, rather than starting
with a setting that goes nowhere.

### A Bot can be asked to do something on a schedule

"Every weekday at nine, post the standup notes here" is now something a Bot can be asked rather than
something somebody has to remember. A routine created this way runs under its own creator's grants —
it can do exactly what they could do in chat, and nothing more — and its reply lands in the channel as
an ordinary Bot message: it lights the unread dot the same way any other message does, and it appears
in the transcript rather than anywhere separate. A routine that fails posts one message about its
first failure and, after ten in a row, switches itself off with a final one rather than failing
forever unnoticed.

The deployment gains two tables, via migration `0021`.

**This needs a new process.** A worker fires due routines by calling this deployment's own API server,
and a deployment that never starts one schedules nothing — the routine sits on the Routines page with
a next run time like any other, and nothing on the screen says a worker is missing. `WORKER_SHARED_SECRET`
is the credential the worker presents; a deployment without it configured refuses every handoff rather
than accepting one it cannot attribute. `scripts/start.sh` runs the worker locally; the Helm chart
turns it on with `routines.enabled` and takes the secret as `secrets.workerSharedSecret`. No new port
is opened for any of this — the worker only ever calls out to the server it already trusts.

### Turn screenshots are swept in every deployment, not one

A page a Bot opens is photographed and kept in `computer_page_frame`, so a conversation read back
later shows what it was looking at. The reaper for those rows had one caller: the idle-computer
culler, which refuses to run unless each Bot has its own computer and is scheduled only by the Helm
chart's CronJob, which exists only when `computers.mode` is `sandbox`. On Compose, on the all-in-one
image, and on the chart's own default of `shared`, nothing ever called it. One browsing Bot over
ninety days is several hundred megabytes of rows that nothing was ever going to remove.

The sweep now runs on the server, on the same hourly timer that removes old audit rows, and does not
wait for a retention policy to be configured: a month of screenshots is what the store already meant
to keep. It also removes them in batches, because one statement over that much data held its locks
for seventeen seconds.

Deployments using `computers.mode: sandbox` are unaffected in what they keep. The culler no longer
purges frames, because the server does it there too and one owner is better than two.

**On upgrade, the first sweep removes the backlog.** A deployment that has been keeping every
screenshot since it was installed will lose the ones older than a month, about a minute after the
server starts. That is the window the store has always documented and the one sandbox deployments
have been enforcing, but it has never been applied anywhere else, so it is worth knowing before the
upgrade rather than after. It is drained in batches, forty thousand rows an hour, rather than in one
statement.

### A channel a Bot has spoken in unseen shows a dot

The sidebar marks a channel when a Bot has said something since you last had it open: a dot beside
the preview, the name a touch heavier. Opening the channel clears it, your own messages never set
it, and the channel you are looking at never shows it. The marker is yours alone — per member, on
the membership row like the pin — so one person reading does not clear anybody else's dot.

The deployment gains one nullable column, via migration `0019`.

### The API can reach Intelligence and sign-in when a NetworkPolicy is on

`networkPolicy.enabled` wrote a rule for the API server that named DNS, the database and the Bots'
computers, and nothing on 443. On a cluster that enforces policy the server could therefore reach
neither CopilotKit Intelligence, nor an identity provider, nor a Bot: nobody could sign in and no
conversation ran. Two of the five shipped `ci/` targets turn the policy on, and on GKE enforcement is
the default and cannot be switched off.

Nothing said so. The pod passed every probe and stayed Ready, because `/health` answers from a
literal, so the first evidence was a timeout to a hostname that read as the internet being down.

The API now reaches HTTP and HTTPS everywhere outside the cluster's private ranges, in every
`computers.mode` rather than only `sandbox`, cut by the same exception list the computers' own policy
uses. It still cannot address another pod, a node, or a cloud metadata endpoint.

`mode: sandbox` had been working only because a rule meant for the Kubernetes API server carried no
destination and so permitted everything. That rule now covers the API server alone, and
`networkPolicy.kubernetesApiCidr` narrows it to your cluster's service range; left empty it stays as
it was, because a chart cannot know that range.

### Taking the wheel stops the Bot's shell, not just its clicks

While a person held the wheel the Bot was refused on the page, and not in the shell. `/exec` and a
workspace write went through, so a Bot could keep running commands and rewriting its `/workspace`
underneath somebody who had taken the browser at a login wall. The guard existed and covered
navigation and the four page actions; the shell arrived later and was never wired to it.

Every acting path now asks the same question in one place, so the property the documentation states
is the property the computer has. Reading is deliberately not acting: `/files/read` and
`/files/list` still answer while a person drives, because a Bot that has just been stopped still has
to be able to say what it was doing.

Nothing to configure. A Bot that acts during a takeover gets the refusal it already got for a click,
and the trail records the attempt and the failure the same way.

### A computer that was suspended once suspends again

Scale-to-zero worked once per Bot. A computer suspended, resumed, used and then left alone again was
offered for suspension on every sweep after that and never suspended, and stayed awake until the next
day. Nothing reported it, because a sweep that offers work and suspends nothing looks exactly like a
fleet that is busy.

The queue keys a suspension on the Bot id and keeps the finished row so that a late offer of the same
key collides with it rather than running the work twice. Both are right. What was wrong is that the
finished row was kept for a day, which is the window the other half of the sweep needs: a suspension
that keeps failing is held back that long before anything tries it again. One number could not be
both, so there are now two, and a finished suspension is kept for the idle window instead. That is
the same clock the offer runs on, so a Bot cannot come back round as idle until its row has gone.

Nothing to configure, and the sweep already runs on a schedule. A deployment where each Bot has its
own computer stops paying for browsers that were used once.

### A Bot's egress proxy is reachable on Kubernetes, or the install is refused

The chart named no egress variable anywhere, so a Helm deployment read the per-Bot proxy settings
nowhere and every Bot went out directly. They were always settable through `computers.extraEnv`,
which reaches the computer in both the shared and the sandbox arrangement, but nothing in the chart
or its README said so, and a setting whose whole purpose is to give a security team a per-Bot
address is not one to leave undocumented.

The other half is that setting it was not enough. A computer is allowed 80 and 443 to public
addresses and nothing else, which is almost no proxies: they sit on a private address, or on 3128 or
8080. So a proxy the network policy provably blocks is now refused at `helm install`, naming
`networkPolicy.computerExtraEgress`, rather than found later as a Bot that fails on every page.
Nothing changes for a deployment that sets no proxy, or one that already opened a path to it.

### A finished turn shows the page it opened, not the one open now

Reopening a conversation made every past turn fetch the screen as it is now, so an answer about
Hacker News from an hour ago sat under a picture of whatever the Bot had open since.

A page is now photographed where it is opened. The server takes the frame the moment a navigation
succeeds and keeps it in `computer_page_frame` under the computer and the address, which is the one
moment the screen is certainly showing the page that was asked for. Reopening the conversation shows
that frame rather than the live screen, and a turn with nothing kept names the page instead of
drawing the wrong one.

The surface used to capture it itself once the turn went quiet, and that is a race it cannot win: a
reopened turn and one that has just finished are indistinguishable from inside the component, the
same computer is driven by other conversations in between, and a resumed computer starts blank. It
filed pictures of pages the turn never opened, or none at all. It only reads now.

**Redeploy the computers with the server.** A screenshot only says which page it is of on an
`agent-computer` built after that field was added, and this is what decides whether a frame is kept.
Where each Bot has a computer of its own there is nobody to race with, so an old computer's picture is
accepted and the feature works through a rollout. On ONE SHARED COMPUTER it cannot be: another Bot's
navigation lands between the navigation and the picture, and a frame that cannot be told apart from
theirs is refused. So a shared-computer deployment that updates the server and not the computer keeps
no frames until it does, and says so in the server log each time rather than leaving somebody to
wonder.

Two things followed from making a past turn a record. Its placeholder is decided by the turn being
over rather than by whether a live frame happens to be in hand, because a tile that was live a moment
ago keeps its last screenshot and used to fall through to "Waiting for the assistant's screen…" and
wait there for ever. And opening one full size shows that same kept frame, with no live stream and no
wheel: zooming a past turn used to mount the socket and offer Take control, so the one gesture for
looking closer at what a turn did replaced it with whatever the Bot has open now.

### A conversation keeps the browsing that produced its answers

Every turn in which a Bot used a tool was disappearing from the transcript on reload. The sentence
the Bot wrote stayed; the browsing that produced it did not, the inline screen went with it, and the
footer said some messages could not be read.

The history store writes a tool call as `{id, name, args}`. AG-UI describes
`{id, type: "function", function: {name, arguments}}`. The reader validated against the second,
treated the first as damage from an interrupted run, and dropped it. It is not damage: it is how
every tool call is stored, so what looked like a guard against one bad turn was deleting all of the
real ones. Observed on a live thread where every browsing turn was counted unreadable and every one
of them was well formed in the store's own dialect.

The two spellings are now read as the same thing. The check stays for turns that really are
malformed, and a mixed or unrecognised array is still refused rather than half-translated, because a
reader that rewrites what it does not recognise is worse than one that refuses it.


### Run this on Kubernetes

A Helm chart under `charts/openbot`, Bots and all, and the fixes that installing it for real turned
up. Proven on a real EKS cluster: five workloads, replicas across two nodes, EBS volumes bound, and a
Bot opening a real page from inside AWS with the decision in the audit trail.

One chart, five targets: EKS with a shared browser, EKS with a computer for each Bot, GKE, AKS and
somebody's own cluster, with nothing but values between them. There is no cloud branching in any template. Every place the clouds genuinely differ is a
value whose default is what a plain self-hosted cluster does: the cluster's own default StorageClass,
no RuntimeClass, a plain Kubernetes Secret, an Ingress. Identity is one `serviceAccount.annotations`
map, which is all IRSA, Workload Identity and AKS workload identity are. Secrets are a plain Secret
by default and an ExternalSecret against any backend when asked, so Secrets Manager, Secret Manager
and Key Vault are a values block rather than three code paths. Gateway API is supported beside
Ingress rather than instead of it. `charts/openbot/ci` holds a values file per target.

Two replicas by default, because horizontal is the point and one replica hides every bug that is
not. A bad install is refused at `helm install`, naming the value to change, rather than discovered
in a crash loop: no database or two of them, nobody who could sign in, nobody who would be an
administrator, a key of the wrong shape, both routers enabled, or a browser asked for inside more
than one replica.

**A Bot's computer is not in an API pod.** The image runs one beside the API so that a single
container works on its own, and `EMBEDDED_COMPUTER=off` turns it off. A replica must not carry a
browser: it is a few hundred megabytes holding one Bot's logins, so scaling the API would scale
those with it.

**Migrations no longer need a development tool.** `bun x drizzle-kit migrate` cannot run in the
shipped image at all. The CLI reads a TypeScript config, which needs the esbuild that
`bun install --production` correctly leaves out, so it printed "Reading config file", exited 1 and
said nothing else. `EMBEDDED_POSTGRES=on` was therefore starting a container whose database was
never migrated, and the first symptom was the API reporting that `users` does not exist.
`server/scripts/migrate.ts` uses the migrator inside `drizzle-orm`, which is a runtime dependency
already, and keeps the same journal, so a database migrated by either tool is migrated.

**A computer for each Bot, suspended when idle.** `computers.mode: sandbox` gives every Bot its own
browser as a `Sandbox` from `kubernetes-sigs/agent-sandbox`, which is built for this workload: an
isolated, stateful, singleton pod with a stable identity and persistent storage. Suspending is one
field, and it keeps the volumes, so a computer comes back with its logins rather than signed out of
everything. `shared` stays the default and needs nothing installed in the cluster.

**The NetworkPolicy would have fenced the API off from its own work.** Its egress named DNS and the
bundled database and nothing else, so on a cluster that enforces policy the API could not have
reached a Bot's computer or, with a managed database, the database. Both are allowed now, and turning
the policy on with an external database and no rule for it is refused rather than shipped. Worth
knowing either way: EKS runs its CNI with `--enable-network-policy=false`, so a policy there installs,
looks right, and does nothing at all.

**A cluster with no controller is refused at install.** `computers.mode: sandbox` needs the
agent-sandbox CRD, and without it the install succeeds, every pod is healthy, and the deployment
looks finished until the first Bot asks for a browser. The chart reads the cluster and refuses,
naming the one command that fixes it.

**What decides a computer is idle is the audit trail, not the browser.** Asking the browser would
wake it, so every computer anything asked about would come back up and the bill would never fall.

**Durable work, claimed by whichever replica gets there first.** `work_items` plus
`select ... for update skip locked` and a lease: no coordinator, no leader election, and a replica
added is throughput added. The idle-computer culler is its first user; scheduled routines and
hand-offs between Bots are the other two, which is why it is written once rather than three times
slightly differently. A CronJob runs the sweep, because a timer in the API fires in every replica and
suspending a browser somebody just started using is not something to do five times.

**Which run of a computer this is, across a suspend.** A resumed browser counts snapshot
generations from one again, so a ref the model still holds from before the suspend would match a row
nothing has overwritten and the boundary would decide about an element on a page that no longer
exists. The first answer here used the node and the pod address, and resuming a real computer
disproved it: a suspended sandbox is very often rescheduled onto the same node and handed the same
address back, so both were identical across a suspend and resume and the check would have said "same
run" for the exact case it exists to catch. It reads the `Ready` condition's transition time instead,
which moves every time a computer starts serving again.

**Which run of a computer this is, on more than one replica.** `sessionOf` answered from a map in
the process that started the computer, which is right until there are two: the replica that took a
snapshot is usually not the one handling the click, and the second had nothing to answer with. An
unknown session means "no opinion" and skips the generation check, so on exactly the deployment
shape it was written for, the check that stops a ref from a replaced computer resolving against a
live one was silently absent. It now asks the supervisor when it does not know, by listing rather
than by ensuring, so asking never starts a computer that had stopped.

### A routing trail says why a message was not routed, not only that it was not

Every untagged message writes a `channel.routed` row, and that row carried `fallback: true` for two
completely different situations: the router answering honestly that no specialist was a confident
match, which is the feature working, and the router not answering at all, which is an endpoint that is
down. Both read identically, so a deployment whose router had stopped working looked like one whose
messages were simply hard to route.

That is not hypothetical. The intent router spent an unknown period 404'ing on every deployment that
set `OPENAI_BASE_URL`, because a `/v1` was appended to a URL that already had one. It was fixed in
0.0.3, whose own note says untagged messages "silently stopped being routed and nothing said why".

The row now carries `undecided`, naming the cause: `unreachable`, `unparsed`, `off-roster`,
`unconfident`, or `one-candidate` — and `null` when the router did decide. Named values rather than a
sentence, because the useful question is how often, and a count needs something to group by.

Two smaller corrections came with it. A message routed to the only coworker that can reach the system
it names kept that as its reason and threw the cause away, so a router that had been down for a week
produced rows reading like reach-based routing working as intended; the cause now survives that path.
And an answer containing no JSON at all — a model replying in prose — was recorded as the router
naming a coworker off the roster, which sends whoever reads it to look at their roster rather than at
the model. It is now reported as unparsed, which is what it is.

Nothing changes about where a message goes. Every routing decision is the same decision it was.

### Notion joins the connector catalogue

Notion is now a governed MCP connector, reached through Notion's own hosted server on the
catalogue's default transport, as the person asking — the same grant, policy and audit machinery
Google Drive already runs through. Unlike Drive, it ships both read and write tools from the start;
the writing ones are named in the catalogue, and an advertised tool absent from that list classifies
as a read — so reconciling the write-tool names against what Notion's hosted server actually calls
them, on the first Refresh tools, is required, not cosmetic. A tool the server never advertised at
all still classifies as a write, same as any other connector.

There is no client to register: this deployment introduces itself to Notion on first connect. That
shortens setup but does not finish it — unlike Drive, whose tool list is this codebase's own code,
Notion's tool list is an answer from Notion's hosted server, so a deployment has recorded none of it
until Refresh tools has run at least once; and, like every other connector, a Bot gets nothing until
its tools are granted to it. Setup is enable at `/admin/plugins/notion`, connect an account at
`/settings/connected-accounts`, refresh tools, then grant — a bulk **Grant tools…** dialog on
`/admin/plugins/notion` grants a batch of tools to a batch of Bots in one pass, one grant and one
audit row per Bot per tool. No migration.

### Refresh tokens rotate in place, and replicas take turns spending them

A vendor that rotates refresh tokens invalidates the one it just handed out, so two replicas racing
to use a stale token would have the loser refused, or worse: a rotating vendor's reuse detection can
read that as a stolen token and revoke the whole connection. Every plugin call that mints an access
token now locks the credential's vault row for the length of the exchange, so a second replica waits
rather than races, and the rotated token is written back in the same transaction that held the lock.
Nothing to configure; a connection just stops going stale under concurrent traffic.

### An MCP token is spent only by its own server, and only at the address it was given

Pointing a server at a credential is the one place this deployment takes a reference to a stored
secret rather than the secret itself. Everywhere else, the value was typed into the same request that
stores it: a Bot's key is minted from what an administrator pasted and the id it gets is nobody's to
choose. So this is the one field where which secret and which address could be made to disagree, and
the add settles the disagreement by spending the credential: the tool refresh runs before the call
returns and sends what it decrypts to the URL from that same request.

Two ways they could disagree, and both are now refused. A server could be pointed at any `mcp`
credential in the vault, including one minted for a different vendor, so a token given to one server
was deliverable to another. And re-adding a server with a different URL rewrote the address while
keeping the credential, so the same token could be sent somewhere else entirely with no
cross-server trick at all: the token really did belong to that server, and only the address moved.

The second is why the first was not enough on its own. A credential now has to belong to the server
it is attached to, and a server that already holds one cannot be re-added at a different address.
Correcting a title or retrying an interrupted add sends the same URL and is unaffected. A server
holding no credential can still be re-addressed, because there is nothing to misdirect. Moving a
server that does hold one means removing it and adding it again with the token the new address is
meant to have, which is the honest description of what has happened anyway.

This matters more than "an administrator could misconfigure something". A stored credential cannot
be read back by anybody, by design: the credentials screen answers that a credential exists and
never what it is. These two shapes were the way around that, so a deployment where somebody has
used them should treat the credentials involved as disclosed and rotate them.

A token also stops outliving the server it was minted for. Re-adding a server without naming a
credential used to clear the pointer while leaving the credential live, and removing a server retires
its token by reading it off that pointer, so a cleared one meant the token survived its server and
could be attached to a freshly created one at any address, where there was no longer a stored address
to compare against. Three ordinary acts in a row and the binding above stopped meaning anything. The
pointer now survives a re-add that names none, removal therefore finds and retires it, and a retired
credential is refused rather than quietly attached to fail on its next call.

Curated servers keep working as they did. Their URL comes from the catalogue rather than the
request, and a per-instance hostname is matched against the vendor's own anchored pattern before
anything is stored, so re-adding one cannot point it at an address of the caller's choosing.

### A configured egress proxy reaches the browser that uses it

`EGRESS_PROXY_DEFAULT` and `EGRESS_PROXY_<BOT>` were documented as the way to give a Bot a stable
outbound address, and Compose passed neither to anything. `docker-compose.yml` named no egress
variable and had no `env_file`, so the shared computer resolved every Bot to no proxy and went out
directly, and under the supervisor the same emptiness meant there was nothing to forward into the
computers it creates.

The failure was silent, which for a setting whose purpose is to give a security team a per-Bot
address for network rules is the worst of the available failures. The stack started, the browser
left by the host, and the Computers screen reported "Leaves directly" because it was reading the
same empty environment.

They now live in `egress.env`, which both the computer and the supervisor are given. A file rather
than more `environment:` entries because `EGRESS_PROXY_<BOT>` is derived from a Bot's id and there
is no fixed set of names to list; a file of its own rather than `.env` because that one holds the
deployment's secrets and the container running a browser and a Bot's shell is deliberately not
given them. It is optional, so a deployment with no proxy is unchanged, and gitignored, because a
proxy URL can carry a password.

**Move these two out of `.env` and into `egress.env`.** In `.env` they reach no process.

### Screens without a conversation stop polling for a Bot that does not exist

Every surface asks which components its Bot holds, and asks again every few seconds so a revoked
grant leaves an open conversation quickly. The Bot it asked about was whichever one the surface
declared — and on a screen with no conversation at all, that was the placeholder id the routing
holder falls back to, which no package registers and the server answers 404 for. An admin page left
open polled a guaranteed miss every five seconds, indefinitely.

Nothing looked wrong. The screen rendered, because an absent grant list and an empty one draw the
same. The cost was the noise: a request log where the same 404 repeats forever is one where the 404
that matters is invisible.

The grant queries now wait for a surface to declare a real Bot, and simply do not run while the
placeholder holds. Conversation surfaces — the Bot page, channels — declare one and are unchanged.

### A rule can be tested against history before it is saved

A boundary was written blind: an administrator typed a CEL rule, saved it, and learned what it
actually matches from the refusals it produced in production. The trail already records every judged
computer action with the same facts the gateway judged it on, so the question "what would this rule
have done" had an answer nobody could ask.

The Boundaries page now has **Test first** beside **Add rule**. The candidate — the current policy
plus the drafted rule — is replayed over recent recorded actions, and the reply names each one it
would have decided differently and the rule that would have decided it. Nothing is saved and nothing
is decided; no audit row is written, because no action was permitted or refused.

Replay, not simulation: the context is rebuilt from the audit row exactly as the gateway built it at
decision time, through the same helpers, so a rule behaves here as it will behave live. The scan is
bounded and biased to recency, and the reply says how many rows it covered.

### A browser refusal names the element again

Every browser context carries a neutral all-empty `mcp` object, so a rule naming `mcp.effect`
evaluates to false instead of throwing. The refusal copy keyed on that object being present rather
than on its contents, so every live browser refusal took the tool-call branch and read
":  on  is blocked" — two empty strings where the element and the page belonged. The tests passed,
because their contexts omitted the field the gateway always attaches.

The branch now keys on the server and tool being named, which a real tool call always has. A refused
click reads "“Submit order” on shop.example is blocked by the rule ..." again, which is what the Bot
relays to the person asking.

### Knowledge searches instead of guessing

A package can say which of its skills each coworker gets, and the fintech example gives Knowledge the
four document skills it ships.

Knowledge is one of three coworkers in the box, described as answering company questions and citing
sources. The skills that would let it do that were seeded attached to nobody, so every clone started
with them paired to no Bot: the per-run narrowing that skills exist for was switched off until
somebody opened the Skills page and made the pairing by hand, in each deployment, again after each
new connector. The pairing belongs with the package, which wrote both files and knows which coworker
it meant them for.

THIS GRANTS NOTHING, which is what makes it safe to seed. A skill is an instruction; what a Bot may
call is its grants, and the offer each run is the intersection of the two. A skill naming a tool its
Bot does not hold loads nothing. Seeding an MCP grant would be the opposite, because those reach a
person's own account, so those stay an administrator's decision and are untouched here.

A redeploy takes back only what the package gave. Grants it made carry `tenant-package`, and a grant
an administrator made through the Skills page keeps their name and survives, because a deploy quietly
undoing a deliberate decision is the kind of change nobody traces back to the deploy that caused it.
A coworker naming a skill its package does not ship is refused at load rather than dropped, the same
as a channel naming an agent that is not there: a typo that silently attaches nothing looks exactly
like working.


### A Bot's computer is no longer on the same network as the database

Compose declared no networks, so every service shared one and reached the others by service name.
One of those services is the container a Bot's shell runs in, and another is PostgreSQL, whose
username and password are in the same file. A shell reaches whatever its container reaches, so a Bot
could open `postgres:5432` and authenticate: the audit trail, the policy store and the agent tables,
from the one container whose job is to run what a Bot asks for. The role Compose creates is the
instance owner, so the trail's append-only trigger was no defence either, being something its owner
can drop.

PostgreSQL and `migrate`, the only service that reaches it by name, are now on a `data` network of
their own. Everything else stays where it was. Nothing changes for a deployment that runs the API
server on the host, which reaches the database through the published port and never used the shared
network for it. **A deployment that runs the server inside Compose has to join that service to both
networks**, which is the one place the two are meant to meet.

The published port is now on loopback, as every other port in that file already was. Taking the
database off the Bots' network removes the name, not the address: a container's default gateway is
the host, and a port published on every interface answers there. From inside the computer container,
the gateway on `5432` accepted a connection and began authenticating as `openbot` on `openbot`, with
the password in the same file. **A deployment that reached the database from another machine over
this port has to reach it another way**, which is what publishing it on every interface was doing.

This does not reach back in time. A deployment that has been running with the two on one network
should assume a Bot could have read or written the database, and look at the trail with that in
mind.

### A credential in an MCP server address is refused in the query and the fragment too

Refusing `https://user:token@vendor.example/mcp` closed the userinfo spelling of a credential in the
address and left the two obvious ones open. `?token=`, `?api_key=` and their neighbours were still
accepted, and the address is stored and named in the trail exactly as given: audit redaction keys on
the field name, `url` is not a sensitive one, so the secret was written to `mcp_servers` and to an
append-only audit row in clear text. That is the same disclosure the userinfo rule exists to prevent,
one character away.

A parameter whose name reads as a credential is now refused, in the query string and in the fragment,
and the refusal points at the token field without repeating what was typed. The name is read rather
than matched against a list, so `?auth_token=`, `?x-api-key=` and `?X-Amz-Signature=` are refused
alongside `?token=`: a rule that only catches the spellings somebody thought of reads as a guard
while behaving like a gap. The test is on the parameter name rather than on the presence of a query,
because vendors route and version with parameters and a floor that refused every one of them would
be one an operator works around instead of with. `https://mcp.example.com/mcp?workspace=acme&version=2`
is unaffected, and so is an ordinary fragment. A credential written into the *path* is still
accepted: it is indistinguishable from a route, and at least one hosted provider addresses servers
that way. **A deployment where somebody has put a credential in an address should treat it as
disclosed and rotate it**, for the same reason as before: the audit row cannot be deleted.

`metadata.goog` is refused too. It is Google's own short name for the metadata server, published
beside `metadata.google.internal`, and it carries a dot and none of the suffixes this check lists, so
it read as an ordinary vendor name. The long spelling was only ever refused incidentally, by the
`.internal` rule. Both are now named, so the address this check was written for is refused on purpose
rather than by luck.

### A curated MCP server is pointed at its own kind of credential too

Adding a server by URL was made to check which credential it is being pointed at. Adding one from the
catalogue, the other half of the same screen, took the same field from the same request and stored it
unread, so a credential of any kind could be attached to a curated server and spent by the refresh
that runs before the add returns.

Worth being plain about the reach, because it is narrower than the path beside it. The column is a
foreign key, so an id naming nothing was already refused by the database, and the one entry in the
catalogue is reached with each person's own Google account, whose OAuth client is registered through
its own call and sent to an address pinned in code. Nothing could be delivered to an address a caller
chose. What was reachable was a credential of the wrong kind being accepted and spent on behalf of
somebody who never agreed to it, and a malformed id arriving as a database error rather than as a
refusal.

The rule now comes from the entry: a server the deployment holds one token for takes that token, and
a server answered as the person asking takes no credential when it is added, because its client
arrives through the call that mints it. Both add paths ask the same question in the same words, so a
credential that does not exist and one of the wrong kind are still refused identically and the
endpoint cannot be used to ask which ids are real. Adding a curated server the way the admin screen
does is unchanged.

Adding a curated server that is already there no longer clears the credential it points at. The
column holds the OAuth client that registering one put there, and re-adding the server to change an
instance host said nothing about that client, but cleared it anyway: the credential row was left
behind with nothing pointing at it and nothing to revoke it, and everybody who had connected their
account was told the deployment has no client registered. A re-add that names no credential now
leaves the one that is there alone.

### Name the private addresses an agent may live at

Refusing `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` in production closed a hole and took something with
it: bring your own agent is a headline capability, a company's own agent legitimately lives at an
internal address, and the only way to reach one was to lift the floor for everything. Telling people
to set that flag is exactly the advice that made it dangerous.

`AGENT_ENDPOINT_ALLOWED_HOSTS` names addresses instead. A comma-separated list of hosts, each
optionally with a port: `agents.internal` covers any port on that host, `10.0.0.42:9000` pins that
one. A deployment sets this and leaves the floor where it is.

It is narrow on purpose:

- **Agent endpoints only.** Browsing is not widened. A page can steer a Bot somewhere; an operator
  naming an address they run is a different act from a Bot following a link to it.
- **Exact matching.** No wildcards and no suffixes. A list written with a `*`, or written as URLs, is
  refused at startup with the entry named, rather than quietly never matching.
- **The never-allowed addresses stay never-allowed.** Cloud metadata is refused before the private
  rule is reached, so naming it changes nothing.
- **Every hop, not just the first.** A named address is reachable wherever it appears and an unnamed
  one is refused wherever it appears, so a redirect is not a way around registration.

Unset means none, which is what every deployment has today.

### A custom MCP server can only be pointed at its own token

Adding an MCP server by URL takes a credential id alongside the address, and the add is what spends
it: the tool refresh that runs before the call returns decrypts whatever that id names and sends it
to the address in the same request. Nothing checked which credential it was, so an administrator
could name any row in the vault, including one person's connector token, and have that person's
token delivered in clear text to an address of the administrator's choosing, before any Bot or grant
was involved. The credentials screen lists every row's id and, for a connector token, the person it
belongs to, so choosing one was a single read.

A custom server now has to be pointed at a credential of its own kind, the deployment's token for
that server. A person's connector token and the deployment's OAuth client are both refused, for the
same reason `POST /api/admin/credentials` already refuses to create either by hand: spending one
here uses a credential on behalf of somebody who never agreed to it. A credential that does not
exist is refused in the same words as one of the wrong kind, so the endpoint cannot be used to ask
which ids are real.

The field is unchanged for the case it exists for, and nothing changes for a server added through
the admin screen, which mints a token and points at the one it just made. If a deployment has a
custom server pointing at a credential of another kind, adding it again will now be refused, and the
answer is to give the server its own token.

### A failed action is recorded the same way it was decided

An action the policy allowed and the computer then failed is recorded twice, once for the decision
and once for the outcome, so the trail can tell an action that happened from one that was permitted
and did not. The second row was leaving out the command and the key that the first one carried.

A shell command that failed part-way therefore said a Bot had run something without saying what, in
the row somebody reading an incident reaches for first. The same omission picked the wrong element
branch, so that row also claimed the command had been looked for in the page snapshot and not found
— a page element a shell call never had. A failed file write kept its path throughout and is
unchanged.

Both rows now carry the same subject. Nothing about the boundary moves: the policy decided on a
complete context before and after, and no action is permitted that was not permitted before.

### Upgrading

**A deployment that sets `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` with `NODE_ENV=production` no
longer starts.** Remove the line and it starts again. Nothing else needs changing, and a deployment
that never set it is unaffected.

The switch lets a Bot reach addresses inside the deployment's own network — `10.0.0.5`,
`192.168.1.1`, `127.0.0.1:5432`, a link-local address — and it does that in two places, not one:
browsing, and the endpoint a Bot may be registered against. It exists for a laptop, where the
services a Bot is asked to look at are the ones running beside it.

The reason this is a refusal rather than a warning is how a deployment came to have it. `.env.example`
shipped the line on, and copying that file is the ordinary way an environment gets filled in, so the
path to a hosted deployment reaching its own network was not forgetting to set something, it was
inheriting something. It now ships commented out, which means a laptop that wants the old behaviour
uncomments it and everything else arrives without it. Under any other `NODE_ENV` the switch works
exactly as before, with a warning at boot saying it does not travel.

**The one-container image shipped with the switch on, and no longer does.** It set both
`AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` and `NODE_ENV=production`, so the image really did run
with private-host browsing enabled. Two things that worked there stop: a Bot browsing a private
address such as an intranet page, and registering a coworker at a private endpoint like
`http://10.0.0.20:8000/ag-ui`. Because the image bakes in `NODE_ENV=production`, there is no
override — a deployment that needs either of those wants the compose setup or its own image rather
than the all-in-one. The image continues to start, and everything else in it is unchanged.

The cloud metadata addresses — `169.254.169.254`, `metadata.google.internal`, and the IPv6 and
NAT64 spellings of them — were refused whatever this switch said, before and after. That floor has
not moved. What changed is that it is no longer the only thing left standing in a production
deployment that copied the example.

### The supervisor answers on loopback, not on every address the host has

The supervisor's port was published without an interface in front of it, so it bound every address
the machine had and answered anything that could route to it. This is the service that holds the
Docker socket, so reaching it is root on the host by way of four verbs, and `SUPERVISOR_TOKEN` is a
shared secret rather than a network boundary. The documentation already said not to expose it
outside the deployment network; the compose file did.

It is now published on `127.0.0.1`, like the computer's own port and the two Bots'. If you reach the
supervisor from another machine, that stops working and it was the thing worth stopping: put the
caller on the host, or run the server inside the compose network, where it reaches the supervisor as
`supervisor:4300` and never uses the published mapping at all. `SUPERVISOR_PORT` still chooses the
host port.

Nothing changes for a default deployment. `scripts/start.sh` already reached it on `localhost`.

### An agent's address is checked where it ends up, not only where it starts

`checkAgentEndpoint` decides whether this deployment will dial an address, and the request was then
handed to a fetch that followed redirects. The checked address and the dialled address were the same
address only while nobody redirected. An agent answering `307 Location: http://169.254.169.254/` put
the server on its own cloud metadata endpoint, on every run rather than once.

Every hop is now checked before it is followed, capped at three. Redirects are still followed,
because a deployment that puts its agent behind one has done nothing wrong, and each destination has
to be somewhere registering it directly would have been allowed to reach. The stored address is
checked before it is dialled too, which is the one address a check reading only `Location` headers
never looked at.

A hop that leaves the host the request was authorised for arrives with nothing that proves who we
are. The customer's key was given to us for their host, and this deployment's signed run assertion
names the Bot and the person and can spend their grants, so both stop at that boundary and do not
come back if the chain returns. A scheme upgrade to the same host and port keeps them.

Refusals are now on the audit trail as `agent.dial_refused`, with the address and the reason. A
refused run already told the person what happened; nothing told the deployment, and an agent that
has quietly started redirecting somewhere it should not is worth being able to count.

### A connector says which of its granted tools it no longer offers

A grant names `serverId/toolName`, and a Bot is told about a tool only when the grant and the vendor's
current tool list agree — so a grant on a tool the vendor has stopped listing reaches no model. That
is a property of what the vendor advertises today rather than of the grant, and nothing said it was
happening: the plugins page built its grant list from the advertised tools, so such a grant appeared
nowhere at all. The one screen an administrator reads to answer "what may this Bot do" was quietly
leaving some of the answer out.

A connector's page now has a "Held but not offered" section listing them, with how many Bots hold
each, and a refresh that leaves any behind writes an audit row naming the refs and the Bots. The
grants themselves are untouched: a tool the vendor starts listing again is offered again, and revoking
stays a decision somebody makes rather than a side effect of a vendor's bad afternoon.

Nothing changes for a connector whose grants all match its tool list, which is the normal case — the
section is not drawn and no row is written.

### Opening a new chat no longer logs a server error

A thread id is minted before the thread exists — the platform creates it on the first run — so reading
history on a brand-new conversation asks about a thread nothing has heard of yet. The platform answered
404, the runtime reported that as `500 Failed to fetch thread messages`, and every new chat left one in
the log with a stack trace behind it. Nothing was visibly broken, because the browser only reads a
history it got a 200 for; what was missing was any way to tell a thread that does not exist yet from a
history store that is down.

A thread the platform does not have now reads as having no messages. A 404 and only a 404: a 500 stays
a 500, because an outage answered with an empty history would tell the browser the conversation is gone
and invite somebody to start it over.

### Reconnecting a live screen no longer stops the screen you just reconnected

A Bot's screen allows one viewer, and opening a second `/stream` replaces the first. The replaced
socket is left open, because it belongs to a client that may still be using it, so on an ordinary
reconnect, where the browser opens the new connection before dropping the old one, the old socket
closed after the new one was already casting. Closing it stopped the session's viewer without asking
whether the closing socket was the one casting, so it stopped the replacement.

Both halves were silent. The screen stopped updating, and anything typed afterwards was dropped
without a word, because the input path looks for a viewer before it looks for anything it can report.

A close now stops casting only when the socket closing is the one that was casting.

### A sidebar channel row can be pinned or deleted

Right-click on a channel in the sidebar and a menu opens with two entries: Pin channel and Delete
channel.

Pin is held per member rather than per channel, so pinning one holds it at the top of your own
roster — newest first among pinned channels — and leaves every other member's roster unaffected.

Delete is confirmed in a dialog first, and it is soft. The channel disappears from every member's
roster and from a direct fetch of it, while the row, its transcript, and its Intelligence thread all
survive. That disappearance is live, not just on next load: every member's open tabs drop the row as
the delete lands, and a tab parked on the channel itself is sent home. The deletion is audited as its
own `channel.deleted` row. A channel the deployment package defines is refused, with the reason
named. Recovery today is clearing `channels.deleted_at` in the database directly; there is no restore
control in the product.

The deployment gains two nullable columns, via migration `0016`.

### An MCP server address that points inside the deployment is refused in three more spellings

Adding an MCP server by URL is checked before the address is stored, because that form is otherwise a
way to point the deployment at its own network. The check compared the literal hostname, and three
spellings of an address it means to refuse were getting through.

A trailing dot is the root-anchored form of the same name and reaches the same place, but it changed
the string enough that every rule missed it, so `https://localhost./`, `https://printer.local./` and
`https://metadata.google.internal./` were all accepted. `kubernetes.default.svc`, which is how a
service is addressed from inside a cluster, carries dots and none of the listed suffixes, so it read
as an ordinary vendor name.

The third is worth acting on rather than just noting. A credential typed into the address itself,
`https://user:token@vendor.example/mcp`, was accepted, and the address is stored and named in the
trail as given. Audit redaction works on field names and `url` is not one of the sensitive ones, so
the token was written to `mcp_servers` and to an audit row in clear text. The trail is append-only by
design, so that row cannot be deleted afterwards: **a deployment where somebody has done this should
treat that credential as disclosed and rotate it.** The address field now refuses a credential and
points at the token field instead.

A deployment that reaches its MCP servers by ordinary vendor hostnames sees no difference.

### One unreadable turn no longer takes a whole conversation down

Restoring a thread cast whatever the history store held straight to messages and handed it to the
transcript. A turn stored in a different shape — a tool call written `{id, name, args}` rather than
AG-UI's `{id, type: "function", function: …}`, which interrupted runs have produced — reached a
renderer that read `toolCall.function.arguments` and threw, so a single bad turn made the whole
conversation unopenable rather than that one message unreadable.

Each stored turn is now parsed against the schema AG-UI ships, and one that does not parse is left
out instead of being drawn. Checked where history enters the app rather than in one renderer, so
every surface that reads a transcript is covered by the same check.

**A turn that is left out is said out loud.** The conversation shows a line above it naming how many
earlier messages could not be read, because a record people read back must not have a hole in it that
nothing accounts for — a turn that silently disappears reads as one that was never sent. Multimodal
content and every well-formed tool call are unaffected, and a history that cannot be read at all
still opens the composer rather than blocking it.

### Refreshing no longer flashes white before the theme arrives

A person with the dark theme selected saw a white frame on every reload. The stored preference was
read early enough, but it was applied one paint too late: the browser had already drawn a frame
against the light palette by the time the app got to it. The document now decides its theme before
anything is drawn.

The browser was also drawing its own surfaces — scrollbars, form controls, the overscroll area —
light under a dark app, for the whole session rather than for a frame. Both themes now declare which
one they are, so those match too.

No configuration changes and nothing is stored differently; a deployment that was already on the
light theme sees no difference at all.

### `start.sh` refuses a port that answers but is not OpenBot

The startup checks asked whether a port answered, and treated that as proof the port belonged to this
stack. Those are not the same claim. Any single-page app serves its index.html for every path it does
not recognise, so an unrelated dashboard on a default port answers `200` to `/api/capabilities` as
readily as this server does.

The cost was not a wrong answer, it was a wrong answer three stages later. `require_free_or_ours`
reported "already up", so the server was never started; `wait_for` then printed a green
"server ready"; and the run failed at stage 3 inside `json.loads`, parsing that stranger's HTML. The
error names `char 0`, which reads like an empty response rather than a `<`, so the visible symptom
pointed nowhere near the port.

Each surface is now asked for something only it can produce: a `licenseStatus` field for the server,
its own `<title>` for the app, `/health` for the compose services. When a check gives up it says
whether the process failed to start or the port belongs to something else.

The root cause was in `.env.example`, and is fixed there too. The server reads `PORT`, this script
reads `SERVER_PORT`, `docs/configuration.md` documents `SERVER_PORT` as the setting, and only `PORT`
shipped. Moving the server by editing that one line left the script still looking at 3001. Both names
are now present, next to each other, saying they have to agree.

**A run may now stop where it used to continue.** That is the point: it stops at the port that is
wrong, naming it, rather than several steps later on a parse error.

### `docker compose up -d` configures the same stack `scripts/start.sh` does

`SUPERVISOR_TOKEN` and `COMPUTER_TOKEN` defaulted to the empty string in `docker-compose.yml`, so
which stack you got depended on how you brought it up. `scripts/start.sh` resolves both to their
`openbot-dev-*` defaults and exports them before calling compose. A plain `docker compose up -d` —
which this project's own shutdown notes tell you to use — passed an empty string instead.

`agent-computer` refuses to start without one, so that half failed loudly. The supervisor half was
the quiet one: the server kept the token it started with while the supervisor held an empty string,
and every call between them was refused at the door.

Both now carry the same defaults `start.sh` applies, as `COMPUTER_IMAGE` already did two lines down.
A value set in `.env` still wins, and a deployment should set one.

## 0.0.4

### A click citing a ref this deployment cannot resolve is refused

A Bot acts on a page by citing a ref from a snapshot, and the server turns that ref back into the
element before the boundary judges it. When the lookup failed, the action went ahead anyway with the
element half of the decision left empty — so a rule like "never click anything named submit" was not
declining to match, it was never shown the element, the shipped default permitted, and the click
landed on whatever that ref points at now.

The computer's own staleness check does not cover this. It compares a citation against its own
counter, so it catches the cases where the two disagree; the case that bites is the one where the
computer is content and only this deployment is out of step, which is what restarting a computer
under a stored snapshot leaves behind. The same click on the same button under the same policy was
refused before a redeploy and carried out after it.

A citation this server holds a snapshot for and cannot resolve is now refused, and the person is told
to take a fresh snapshot. Actions that name no element — scrolling, a page-level keypress, a shell
call, a file read — are untouched, and a computer this deployment holds no snapshot for still has its
citation forwarded, because there it is the only party that can answer. The refusal is raised after
the decision row is written, so an action somebody tried to take still appears on the trail.

**A deployment may see refusals it did not see before.** That is the point: those are the actions that
were being carried out without the boundary seeing what they touched. A Bot that meets one takes a
fresh snapshot and continues.

### A package ships its skills, so tool selection works on a clone

Tool selection narrows a Bot's tools to the ones its matching skills declare, and a deployment starts
with no skills at all. There was no `skills.yaml`, nothing seeded any, and nothing ever created one
— so on every fresh clone there was nothing to match against and the narrowing never switched on.
Left to a screen it would have stayed that way until somebody sat down and mapped tools to skills by
hand, in each deployment, again after each new connector.

A tenant package may now carry `skills.yaml`. Each skill has a slug, a title, a summary, its
instructions, and the `serverId/toolName` refs it needs. They are seeded on boot as deployment
skills, everybody sees them in the `/` menu, and connecting a connector is the only step left.

`skills.yaml` is optional, so every existing package loads unchanged and ships no skills. A package
may declare tools for a connector nobody has added: an unknown ref sits inert, because the offer is
still intersected with the Bot's grants. Naming a tool in a package grants nothing, exactly as
before.

A skill somebody wrote in the deployment keeps its name. If a package ships a slug a person already
took, theirs stands, the package loses that one, and the deployment starts — a name is not worth
refusing to boot over.

The example package ships four: `/find-a-document`, `/whats-changed`, `/who-owns-this` and
`/check-a-claim`.

### The tools a skill needs can be picked where the skill is written

A package's skills arrive with their tools declared. A skill somebody writes here could not: the
`tools` field existed on the save endpoint and on no screen, so a skill written in the product declared
nothing, and the only way to change that was to call the API by hand. Writing or editing a skill now
lists the tools of every connected server, grouped by server, with the ones that change something
marked.

Picking a tool here is not granting it. The offer is still intersected with what the Bot was granted,
so a skill naming a tool its Bot does not hold selects the skill and loads nothing — which is why
anybody may write a skill while connecting a server stays an administrator's decision. The screen says
so, next to the choice.

A tool the skill names that no connected server offers is shown too, under its own heading, rather
than left out. A package ships skills declaring tools for connectors nobody has added yet, and a
skill outlives the server it was written against, so a screen that drew only what matched was
stating part of the declaration as though it were all of it.

## 0.0.3

### A Bot is offered the tools its message needs, not every tool it holds

A model chooses the right tool reliably out of about ten and unreliably out of thirty, and it fails
quietly: it calls a plausible neighbour, or calls nothing and answers from what it already knew. Two
connectors is enough to cross that line, so a Bot holding more than twelve tools is now offered, for
each run, the tools of the skills that match the message.

Skills already declare the tools they need. That declaration is now what the offer is built from:
the deployment asks its own model which skills a message needs, and the Bot gets those skills' tools
plus every granted tool no skill has claimed. Nothing here can widen a Bot: the offer is intersected
with the grants, so naming a tool in a skill still grants nobody anything.

Nothing changes for a deployment that has not declared tools on any skill, or whose Bots hold twelve
tools or fewer. Those Bots are built exactly as before, with no extra model call.

There is a new audit event, `mcp.tools_discovered`, written before the run. It says how many tools
were offered out of how many granted, and why: the skills chosen, or that nothing was declared, or
that the choice could not be made. It answers "why did it call that", and the harder question, "why
did it not call anything at all" — which until now left no trace.

### The intent router works again behind a gateway

`OPENAI_BASE_URL` is documented ending in `/v1`, and the router appended `/v1/chat/completions` to
it, so every call went to `/v1/v1/chat/completions` and 404'd. The router reads a failure as "not
sure" and falls back to the default coworker, so on any deployment that set the variable — a
gateway, a proxy, a self-hosted model, which is the only reason to set it — untagged messages
silently stopped being routed and nothing said why. The version segment is now added only when the
configured URL does not already carry one.

## 0.0.2

### Upgrading

`AGENT_TOOL_TOKEN` is generated for you on a laptop. `scripts/start.sh` mints one and writes it to
`.env`, the way it already did for `MANAGED_AGENT_TOKEN`. Without it no Bot could call a tool back
through the deployment, which is the correct default for a deployment and made every MCP tool dead
on arrival on a fresh clone. A value already set is kept, and `.env.example` still ships it empty,
so a deployment not using `start.sh` is unchanged and still fails closed.

`start.sh` also stops skipping work for services that are already answering. A Bot container is now
handed to `docker compose` on every run and the server is restarted when this run minted a secret,
because answering says a process is alive and not that it still agrees with the deployment. The cost
is that a run which rebuilds an image recreates the Bot containers, about five seconds; `supervisor`
already behaved this way.

Two configurations now refuse to start:

- A provider configured with no `INITIAL_ADMIN_EMAILS`. Set it to at least one address.
- No provider at all and no `OPENBOT_SINGLE_USER=true`. Configure a provider, or set that to say you
  meant a deployment where every visitor is one administrator. This no longer depends on `NODE_ENV`,
  which is unset by default and so let exactly the dangerous case through. A deployment already
  running open needs the line added before it will start again.

Registering an OpenID Connect provider needs every host in its discovery document in
`TRUSTED_ORIGINS`, not only the issuer. Better Auth 1.7 checks each endpoint it finds, so a Google
issuer also needs `oauth2.googleapis.com` and `openidconnect.googleapis.com`. Registration is
refused with the untrusted host named.

A Bot id may now contain only letters, digits, hyphen and underscore, and must start with a letter or
digit. The same rule container and volume names have always followed. A deployment whose
`COMPUTER_BOT_ID` breaks it refuses to start and says so, rather than answering 400 to everything.

`AUDIT_RETENTION_DAYS` is new and unset, which keeps the audit trail forever, as before. Set it to a
whole number of days to have old rows removed.

The local document index and the old connector tables are dropped by migration. `documents`,
`chunks`, `document_acls` and the four connector-bookkeeping tables are removed and their rows go
with them; this cannot be rolled back. A deployment that had been syncing into the local index loses
that copy, which is the point: answering now goes through a live system's own search.

**An MCP server pointed at a credential that no longer exists loses the pointer.** `mcp_servers`
now names its credential with a real foreign key, where the column was `text` against a `uuid`
primary key with nothing checking it — so a deployment is allowed to be holding a pointer to a vault
row that was deleted underneath it, and the screens read as though the server were still configured.
The migration clears those before adding the key, because it cannot add it otherwise. If this
happens, that connector correctly reports having no credential and an administrator registers it
again; nothing else is affected, and a deployment with no such pointer sees nothing.

**The old Google Drive connector is gone, and it is not the new one renamed.** It configured a
service account with domain impersonation and had the worker sync documents into a local pgvector
index guarded by our own ACL rows, so every person got the same answer computed from what one
credential could see, and revoking somebody's access left a cached copy of their documents behind.
`/admin/connectors` and its two screens, the connector catalogue and admin service, the sync
persistence and the worker's connector runner have all been removed. A deployment that was syncing
this way stops syncing and should enable the new connector at `/admin/plugins/google-drive`, where
each person connects their own account.

`knowledge.yaml` is still parsed and still refused when malformed, because it is part of the
deployment-package contract. Its `sources:` are now read by nothing.
`MANAGED_AGENT_AG_UI_URL` is no longer required to start. The one-container image does not carry a
Bot, so requiring it registered the shipped Risk Analyst against a host that was not there and every
conversation with it failed. Leave it unset for that image. A laptop `scripts/start.sh` still points
it at `agent-langgraph`. A URL with no `MANAGED_AGENT_TOKEN` still refuses to start; a leftover
token with no URL is ignored.

A `.env` copied from an older `.env.example` still has `MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui`.
Unset it before `docker run --env-file .env`, or the coworker comes back.
The built-in Bot refuses to start without `OPENAI_API_KEY`. It used to start, report healthy, and
then fail every conversation, so a missing key looked like a working deployment. The LangGraph Bot
already refused the same way.

Sessions survive and nobody signs in again.

### Changed

- **This deployment does not search documents itself.** A Bot answers from a live system by calling
  that system's own search as the person asking, so the vendor decides what they may see and there is
  no second copy of anybody's documents here to keep in step, to secure, or to leave behind when
  somebody is removed. The local index that was being filled — `documents`, `chunks` and
  `document_acls` — and the connector that filled it have both been dropped. Retrieval over
  a copy of a customer's corpus is not a thing OpenBot does.

### Added
- **A skill can say which tools it needs.** `POST /api/plugins/skills` takes a `tools` list of
  `serverId/toolName` references, stored against the skill and returned with it. This is the unit
  tool retrieval will select over: a model picks a skill from its summary, and the skill says
  what to load. **It grants nothing.** A skill naming a tool a Bot was never granted still cannot
  call it, which is what keeps writing a skill open to anybody rather than to administrators
  only. A reference naming no tool this deployment has seen is refused when the skill is saved,
  so a typo is an error where it was written. Leaving the field out of a save leaves whatever was
  declared before, so nothing that predates it clears a declaration; sending an empty list is how
  a skill stops asking. Nothing consumes these yet — selection is the next piece, and until it
  lands a deployment behaves exactly as before.
- **A message with no `@` goes to the coworker it is for.** Typing without naming anyone used to
  reach the default coworker; to get a specialist you had to `@` them. Now an untagged message is
  routed to the coworker whose purpose matches it, chosen against each coworker's own description by
  the deployment's own model, before the channel is pinned. It is named, not silent: the channel
  header is the coworker it went to, and a `channel.routed` row records the choice, the reason, and
  the candidates it chose between (never the message itself). `@` still wins as an explicit override
  and skips routing entirely. If the router is uncertain or unreachable, it falls back to the same
  default the composer always used, and says so, rather than misroute or drop.

- **A Bot can answer from Google Drive, as the person asking.** Ask a Bot a question whose answer is
  in a document and it answers from the live file rather than from an index, citing a link that opens
  it. A Bot granted these tools reads Drive on the asker's own grant, so two people asking the same
  question get the answers their own accounts can see, and neither sees the other's documents.
  Read-only: the scope requested is `drive.readonly`, so a write is refused by Google before this
  deployment has to. Nothing is cached — the refresh token is stored and an access token is minted
  per call, so revoking access at Google takes effect on the next one rather than when a cache
  expires.

  Setting it up takes two people and neither can do the other's half. An administrator registers a
  Google Cloud OAuth client and enables the connector at `/admin/plugins/google-drive`; each person
  then connects their own account, and there is deliberately no endpoint for an administrator to
  connect one on somebody's behalf. The redirect URI has to match what is registered character for
  character, and the connector page states the exact string to paste, because a mismatch fails at
  Google with a message that never mentions OpenBot. See
  [docs/plugins/google-drive.md](docs/plugins/google-drive.md) for the whole setup and for what each
  failure means.

  **Disconnecting is not built yet.** The account page says so and points at Google's own third-party
  access settings, which is what withdraws it today.
- **Each tool a connector offers has its own screen**, at `/admin/plugins/<connector>/tools/<tool>`,
  with a switch per Bot. The connector page previously drew a button per Bot inside every tool row,
  which is a control per Bot per tool stacked in one list, and grew without bound as Bots were added.
- **Connected accounts**, at `/settings/connected-accounts`. What a Bot may read as you, and the
  scope the vendor actually granted rather than the one that was asked for.
- **A tool result that found nothing says so.** An empty result used to reach the model as an empty
  string, which reads as "the tool had nothing to say" rather than "there is nothing there" — and a
  model closes that gap from memory, which for a knowledge connector is the failure worth preventing.
- **The shipped Knowledge Bot answers from the tools it has.** Its instructions in
  `examples/fintech` told it to say no source was connected, which was honest when none could be:
  the connector this replaces had been removed and nothing had taken its place. With a connector
  granted it became the opposite of honest — the Bot called a tool, was handed a file listing, and
  said it had no access anyway. It now reports what its tools return, says so plainly when it has no
  tool or a tool reports a problem, and does neither of the two things worth forbidding: answering
  from its own memory as though it came from a source, or claiming to lack access to something a tool
  has just returned. A deployment with its own tenant package is unaffected.
- **`mcp.call_failed`.** A call this deployment permitted and the vendor did not complete now leaves
  a row of its own, carrying the vendor's own sentence. `mcp.call_succeeded` was written before the
  network call rather than after, so a call that died at the vendor recorded success and the Admin
  page agreed with it.
- **Releases are cut by a workflow, not by hand.** `Create release PR` bumps the version and promotes
  `## Unreleased` to a numbered section; merging the pull request it opens is what publishes. Merging
  builds and pushes one image to `ghcr.io/copilotkit/openbot`, signs a build provenance attestation
  for its digest, tags the commit and creates the GitHub Release with `container-images.json` so a
  deployment can name an exact digest rather than a tag somebody could move. See
  [docs/releasing.md](docs/releasing.md).
- **CI now runs the thing it ships.** Two checks were added. `migrations` refuses a schema change
  with no migration written for it, and a snapshot that has drifted from the schema. `image` builds
  the container, boots it with embedded PostgreSQL, and fails if it does not answer or if a
  supervised service is respawning. A single `verify` check covers every job, so branch protection
  needs one entry. The same checks run again against the release commit when a release is published,
  so they gate the release rather than the proposal for one.
- **Sign in with Google, Microsoft or Okta.** Any one of them turns sign-in on; configure several
  and the sign-in screen offers each, on matching buttons carrying each provider's own mark.
  `INITIAL_ADMIN_EMAILS` says who is an administrator. It is required whenever a provider is
  configured, because nothing else grants the role, and it is now a floor rather than a one-off:
  an address it names is made an administrator at every sign-in, so adding somebody to the list
  works even after they have already signed in.
- **SAML and OpenID Connect, registered while running.** `/admin/identity-providers` takes the
  metadata a company's identity team supplies and registers their own IdP. Somebody then types their
  email address on the sign-in screen and the domain decides which provider they are sent to, so a
  company mid-merger can run two. Registering, changing or removing one is administrator-only, which
  the upstream plugin does not require: it guards those routes with a session, and anybody who could
  reach them could register a provider for a domain and mint themselves colleagues.
- **A People screen.** `/admin/people` lists everybody who has signed in, with the provider they came
  through and when they were last here, and lets an administrator promote, demote, or remove
  somebody. Removing ends the session they are using and stops the next sign-in, keyed on the
  address so signing in again through the provider does not quietly create a new account. Every
  change is on the audit trail. Somebody named in `INITIAL_ADMIN_EMAILS` cannot be demoted or
  removed here, and nobody can do either to themselves.
- **One container that runs the whole thing.** The root `Dockerfile` builds an image carrying the
  app, the API, a Bot computer, and optionally PostgreSQL, supervised together. Point `DATABASE_URL`
  at a database you already run and the built-in one never starts; leave it unset and the container
  is self-contained. See [docs/deployment.md](docs/deployment.md) for the measured minimum sizes and
  the platforms it has been run on.
- **Bots can run commands.** `computer_run_command` runs a command in the Bot's `/workspace`, so a
  Bot can install a tool, unpack what it downloaded, or run what it was asked to run instead of only
  driving a browser. Governed like every other action: the policy decides, the audit row is written
  first, and a rule can refuse a shell outright with `intent == "run_command"` or refuse particular
  commands. The command is recorded; its output is not.
- **The audit trail shows the command.** A command row names what ran, the way a file row names the
  path, rather than reporting an element it was never about.
- **`COMPUTER_SANDBOX=on`** turns on Chromium's own sandbox where the host permits user namespaces.
  Which way it went is printed at start-up either way.
- **New chat.** The direct Bot chat has a button that starts a fresh conversation, which it had no way
  to do before: the thread was minted once and remembered for that Bot forever, so the only way out
  of a conversation was to clear the browser's storage by hand.
- **You can watch what a Bot is doing, not only what it is looking at.** The screen answered half the
  question: a Bot spending two minutes in a terminal showed a blank browser and one grey line per
  command, with the output nowhere. A command line in the transcript now opens to show what it
  printed, its exit code, and whether it was cut short or stopped. Beside the screen there is an
  Activity tab carrying every command, file read, file write and listing as they happen, newest
  first, with a count on the tab so a Bot working away from the browser is visible without switching
  to it. A saved file shows its path and size, never its contents. This is a live view of the open
  conversation; the record is still the audit trail.
- **Sign-in is on the audit trail.** Rows for signing in, for being refused, and for the configured
  administrator list granting somebody the role. Two questions had no answer before: who granted
  themselves administrator by editing `INITIAL_ADMIN_EMAILS`, and whether somebody just removed had
  ever been here, since removing them deletes the sessions that were the only evidence. A trail that
  is unavailable never blocks a sign-in.

### Fixed
- **A ref could resolve against a page from a computer that no longer existed.** The generation a
  computer stamps on a snapshot is unique only within one run of it, so a replaced container counts
  from one again and a ref the model is still holding matches a row nothing has overwritten. The
  policy then decides on an element from a dead page, and the audit row names it. Wiping a computer
  cleared the row for that reason and was the only thing that did; replacing one whose image changed
  did not, and the server was never told. A snapshot now carries which run of the computer took it,
  refs from an earlier run resolve to nothing, and the first snapshot of a new run replaces the old
  row however low its generation.
- **A migration stamped in the future silently swallowed the next one.** Drizzle runs a migration only
  when its journal timestamp is later than the newest one the database has recorded, so a migration
  stamped ahead of real time raises that ceiling and every migration written after it is skipped
  until the clock catches up. `drizzle-kit migrate` reports success the whole time. One migration was
  hand-written a day into the future and did exactly that to the next one to arrive: the table was
  never created, and the only sign was an integration test failing on a relation that did not exist.
  The timestamps are corrected, an older inversion between two earlier migrations is corrected with
  them, and the journal is now checked by a test, because nothing else in the build would notice.
  **If you ran a build between these, your database has the wrong ceiling recorded and will skip the
  next migration.** Repair it with
  `update drizzle.__drizzle_migrations set created_at = 1787359000000 where created_at = 1787444747113;`
  or start from a fresh database, where migrations all run in one pass and ordering cannot bite.
- **Every Bot ran a model two generations old, and it was costing tool calls.** The example package
  shipped `gpt-4.1` as the default for every built-in Bot. Asked to open a page behind a sign-in,
  those Bots answered "would you like me to prompt you to sign in?" and called nothing, three times
  out of three, while the prompt forbids that sentence in as many words. On `gpt-5.6-terra` the same
  question produces the tool call first try, so the package now runs `gpt-5.6-terra`. It is a
  default, not a commitment: `model.yaml` still decides.

  The Bots that answer over AG-UI stay on `gpt-5.5`, each for its own measured reason. The framework
  Bot answers nothing at all on `gpt-5.6-*` through the Responses API — `RUN_STARTED`, then
  `RUN_FINISHED`, no text — and the hand-written one cannot use function tools on
  `/v1/chat/completions` with a 5.6 model unless reasoning is turned off, which is the wrong trade
  for a Bot whose job includes deciding when to ask a person for help. It refuses to start on such a
  model now rather than failing one silent tool call at a time. Where a 5.6 model is set deliberately,
  the Responses API is switched on for it automatically, because a deployment that set the model and
  did not know about that switch got a Bot which started, looked healthy, and failed on its first
  tool call.
- **A Bot browsed to a vendor this deployment already connects to.** A Bot holding no grants was told
  nothing about connectors at all, so it treated a connected vendor as an ordinary website: asked
  about Google Drive it opened `drive.google.com`, met a sign-in page, and asked the person to sign
  in to an account the deployment had already connected. Every Bot is now told which vendors exist
  here, held or not, and says plainly which one it has not been granted rather than reaching for the
  browser.
- **A conversation was destroyed by a declined take-the-wheel.** A Bot that asks for help with a
  sign-in and never gets it left a tool call nothing ever answered, and every later turn in that
  thread failed at the provider. This was fixed once for the framework Bot and not for the Bot in the
  box, which is the one behind the Browser Bot, so it went on happening where most people would meet
  it. Both now answer their own unanswered calls with the truth rather than a fake success.
- **A Bot refused because a person had the wheel was told its refs were stale.** The computer flags a
  takeover, the surface branches on that flag, and the flag did not survive the server, so a Bot was
  sent back round the same action against the person who had just taken the browser. Reported and
  fixed by @beardthelion.
- **A person could not take the wheel unless the Bot offered it.** The button appeared only after a
  Bot called for help, so the control a person needs depended on the Bot getting one instruction
  right, and when it did not there was nothing to press. It is there whenever the Bot is driving now.
  The Bot asking for help is still its own row, with its reason.
- **The first message of a new channel could be lost.** A new channel's thread does not exist until
  its first run, so the join that restores history had nothing to settle against; the message was sent
  anyway after a deadline, while that join was still in flight, and the join finishing replaced it
  with the thread's messages, which were none. The deadline now ends the join and waits for it, so
  nothing is left in flight to overwrite anything. The transcript also says it is loading rather than
  showing an empty conversation, and the thinking line is visible for the first time: a CSS rule
  blanked the colour a gradient was built from, so the glyphs were painted with nothing. Reported and
  fixed by @zopeVaibhav.
- **The in-memory snapshot store disagreed with the table.** The database only ever moves a snapshot
  forward; the in-memory one, which is what a test reaches for when it has no database, took whatever
  arrived last. A test could therefore prove a boundary property that is false in a deployment.
  Reported by @beardthelion, fixed by @NathanTarbert.
- **A computer that had opened nothing still reserved a browser-sized frame.** That put a placeholder
  the height of a browser window into the middle of a conversation, above an answer that never
  involved the browser.
- **A Bot named after a deployment route was served without its guard.** The computer router steps
  aside for `/policy` and `/fleet`, which are its own paths and not about a Bot, because Hono matches
  `/*` against zero segments and a single-segment path arrives as a Bot id. It stepped aside on the
  name alone, so it covered everything under those names too: `/policy/status` is `/:botId/status`
  with a Bot called `policy`, and for that whole subtree the access check was never called at all.
  The guard now steps aside only for the deployment path itself, and a Bot may no longer be named
  after one: a package declaring it is refused, and a deployment that already holds such a Bot
  refuses to start and names it rather than serving it. Reported and fixed by @beardthelion.
- **Upgrading never reached a Bot's computer.** A computer is a container the supervisor makes, and it
  was reused by name whatever image it was built from, so once a Bot had one, rebuilding the image
  moved the tag and the container went on running the old one indefinitely with nothing to say so.
  `docker compose down` does not touch these either, because compose did not make them, so even a
  full teardown left them behind. That is worse than stale code: the computer is the browser, the
  workspace and the confinement around both, so a fix to any of them silently did not apply. A
  computer built from a different image is now replaced on next use. Its profile and its workspace
  are volumes and are kept, so a Bot comes back on the new image still signed in to what it was
  signed in to, with its files where it left them.
- **The audit trail could be erased with one statement.** It is append-only because a database
  trigger refuses updates and deletes, and that trigger is row-level, so `TRUNCATE` never reached it:
  anything holding `DATABASE_URL` could empty the table and nothing raised. That is the case the
  guarantee exists for, since it is enforced in the database precisely because the application is not
  the only thing that reaches the table. A statement-level trigger now refuses a truncate, and it
  answers before the retention setting is read, so declaring a retention window no longer permits one
  either. Retention itself is unchanged: rows older than the window are still removed, and recent
  ones are still refused. The connection the application uses is the database owner in the shipped
  compose file, and an owner can still disable or drop a trigger; closing that needs a role with
  `INSERT` and `SELECT` only, which is a separate change. Reported by @beardthelion, who also named
  the failure mode of the obvious fix and saved it from shipping as one.
- **A declined take-the-wheel destroyed the conversation.** A Bot that asks for help with a sign-in
  and never gets it left an assistant message holding a tool call that nothing ever answered, and
  every later turn in that thread failed at the provider. Declining once meant nothing you typed
  afterwards got an answer, with no way back but a new chat. Unanswered calls are now answered when
  the history is rebuilt, with the truth rather than a fake success: no result came, the run has
  ended, carry on without it and say what could not be done.
- **The audit trail could not say why a conversation went where it did.** It recorded the router's
  choice and recorded nothing at all when a person named a coworker with `@`, which is
  indistinguishable from a row that failed to write. A mention is now recorded too, as the person's
  own choice, without asking the model a question they had already answered. The audit page names the
  coworker and separates the three cases: chosen by the person, matched by the router, or the default
  because nothing matched.
- **A Bot with half a connector sent people to a sign-in box.** Granted a vendor's search but not its
  read, it found the document, could not read it, and opened the vendor's website to try, where it
  met a sign-in wall and asked the person to take the wheel. They already had access; the missing
  thing was the Bot's grant, and nothing said so. A gap in what a Bot holds is now reported as a gap:
  it names the capability it would need and says an administrator can grant it on that connector.
- **Answers arrived with no sign of where they came from.** Asked a compliance question, a Bot
  replied with a filing obligation, a dollar threshold, a deadline and a retention period, and the
  audit trail for that turn held one row: the routing decision. A confident unsourced answer is
  indistinguishable from a confident wrong one. Every Bot is now told to cite what it read and to say
  plainly when an answer is from its own knowledge instead. It is told this by the deployment rather
  than per agent, so it cannot be missing from the next Bot somebody adds, and it is explicitly not
  an instruction to go hunting for a source.
- **A Bot browsed to a vendor it already had tools for.** Granted Google Drive, asked what was in a
  document, it opened `drive.google.com` in its own browser, met a sign-in page that browser can
  never satisfy, and asked the person to sign in to an account they had already connected. A tool
  array says a tool exists; it does not say the tool is the way to reach that system, and it was
  competing with a page of prose about the browser that mentions connectors nowhere. A Bot is now
  told which systems it holds tools for, generated from its grants and placed before that prose, so
  enabling a connector changes what the Bot is told on its next run.
- **A question went to a coworker that had no way to answer it.** Routing read the sentence somebody
  wrote about what a coworker is for, which is not the same as what it can reach, so a question about
  a Drive document went to the one whose description says "company knowledge" and which held no Drive
  grants. Candidates now carry the systems they hold tools for. Purpose still decides first: a
  specialist with no connectors is still right for a question about its specialism.
- **A deny rule about submitting a form was walked around by typing.** `computer_type` takes a
  `submit` flag that presses Enter once the text is in, and the policy never saw a key, so a rule
  refused at the button and at the keypress let the third route through. Both shipped copies of that
  rule name both tools now, the key reaches the policy, and the audit row carries it — without it a
  row said a field was filled in rather than that a form was sent.
- **A Bot refused at the door left no trace.** A callback that could not prove which Bot it was
  returned 401 and wrote nothing, so a Bot holding a token the deployment no longer accepted had
  every call refused, returned nothing to its own model, and the model told the person there were no
  results. A false negative delivered as an answer, with the audit trail agreeing nothing had
  happened. Recorded now as `mcp.callback_refused`, naming the tool and the reason but no Bot or
  actor, since both arrive in the credential that just failed to verify.
- **An unanswered request for the wheel followed a Bot around.** Control belongs to a Bot's computer
  rather than to a conversation, so a request nobody took sat there indefinitely and every later
  conversation with that Bot showed a live prompt for work it was not doing, captioned with a reason
  written for somebody else. An unanswered ask now stops being shown after ten minutes and its reason
  goes with it. A person actually holding the wheel is never timed out.
- **`/admin/computers` listed nothing, ever.** Admin addressed the fleet through a per-Bot route with
  a placeholder id, which stopped working when that route began checking whether the caller may act
  as the Bot in the path. The screen renders nothing while the list is null, so a deployment with two
  running computers looked like one with none. The fleet has a route of its own, still
  administrator-only.
- **Every shipped component was recorded twice on a first start.** Two browsers announcing at once is
  ordinary and the insert was already safe for it; the answer was not, so the loser of that race
  named every component anyway and the caller wrote an audit row per name.
- **A Bot could reach the deployment's own network by writing the address a different way.** The
  guard refused `169.254.169.254` and the private ranges as usually written, but not the same
  addresses spelled as an IPv6-mapped or NAT64 form, an integer, or with a trailing dot, so a Bot
  talked into fetching one still reached cloud metadata or an internal host. The address is
  canonicalised before it is checked now, the mapped form of `0.0.0.0` (which reaches every local
  port) is refused, and the container credential endpoints a hosted deployment must never expose —
  ECS and Fargate's `169.254.170.2`, Alibaba's `100.100.100.200` — are refused even when the
  private-host opt-in is on. The same guard backs agent registration, so it is closed there too.
- **The supervisor could adopt a container it did not create.** When starting a Bot's computer hit a
  name already taken, it started whatever held the name and handed it the deployment's computer
  token, so on a Docker host shared with anything else it could drive a stranger's container as a
  Bot's. It now refuses a container that does not carry its own namespace label, read from the
  container rather than inferred, so a second deployment on the same host is never adopted.
- **Removing somebody left the credentials they had granted this deployment sitting in the vault.**
  Removing them from the People screen ended their sessions and stopped the next sign-in, and left the
  refresh token behind, unrevoked. They could not use it — the account comes from a session they no
  longer get — but "we removed their access" was not true of the token, which for a connector read as
  the person asking is the part that matters. Removing somebody now retires it, and each retirement is
  on the audit trail as `mcp.account_disconnected`. Deleting a person's row used to be worse, because
  it took the connection record with it and left the credential reachable by nothing at all; those are
  found and retired too. This stops the deployment holding a usable secret. It does **not** withdraw
  the grant at the vendor, which needs revoking there until disconnect ships, and the audit row says
  which of the two happened rather than implying both.
- **The one-container image registered a coworker it could not run.** `MANAGED_AGENT_AG_UI_URL`
  defaulted to `localhost:4201` and was required, so Risk Analyst appeared on the roster and every
  conversation with it failed. The URL is optional; the package omits that coworker when it is
  unset. `scripts/start.sh` still points it at `agent-langgraph` on a laptop.
- **A boundary rule applied on one server out of N.** The policy is read from memory on every action,
  which is right, but memory was only ever filled at boot. An administrator's new deny rule was
  enforced by whichever process served the request and roughly one action in N went through it, while
  the admin screen reported success because the row really was saved and the audit trail agreed
  because it records the boundary each process started with. Both honest, and both describing
  something other than what the fleet was enforcing. A write now announces on Postgres in the same
  transaction and every server re-reads, including on reconnect, so a server that was down when the
  rule changed catches up rather than waiting for a restart. Reset travels the same way.
- **A ref resolved on one replica and nowhere else.** The gateway turns the opaque ref in a click into
  the element it points at, and that mapping lived in a `Map` in the process that took the snapshot.
  On any other replica the ref resolved to nothing, so a deny rule written about the element did not
  match and the click went through, recorded as allowed with no rule. It is in Postgres now, keyed on
  the generation the computer stamped, so a ref from a superseded page still resolves to nothing.
- **Anybody signed in could act as anybody's Bot.** The Bot id travels in the path and the acting
  routes checked only that somebody was signed in, so a signed-in person could drive another person's
  private Bot, reset its browser, read its screen and fire its granted tools. Every route under a Bot
  id now asks the store the same question the roster already asks, and a Bot that does not exist and
  one belonging to somebody else answer identically.
- **The computer fleet listing was open to any signed-in person.** It ignores its `:botId` and returns
  every Bot's machine, so it told anybody who could reach it every Bot id in the deployment and
  whether each was running, private coworkers included. Administrator-only now.
- **A Bot id could name a directory outside the profiles volume.** The id arrives as a URL segment or
  a header, was joined onto a filesystem path, and `reset` deletes that path recursively as root, so
  `../../tmp/something` deleted it. Refused at the request boundary and again where the path is built.
- **A mistyped deny rule permitted instead of refusing.** A rule that parsed and evaluated but
  answered with something other than true or false was neither a match nor an error, so
  `deny: ["Submit order"]` — what somebody writes who reads the list as labels — let the action
  through with nothing logged, while the rule sat on the Boundaries page looking as though it were in
  force. Any non-boolean answer is now a broken rule and takes the existing fail-closed path.
- **Rotating a Bot's key left the old one live.** Editing a key wrote a new vault row and repointed
  the Bot at it, leaving the previous credential decryptable and still valid with nothing listing it,
  so rotation did not do the one thing rotation is for. Deleting a Bot left its key live too. Both
  revoke now.
- **Nothing recorded what changed about a Bot.** Ten mutating routes wrote one audit row between them
  and there was no event type for any of the other nine. A Bot's endpoint is where conversation
  content is sent, so "who pointed this Bot at that host, and when" is the first question in an
  incident and could not be answered. Eight event types and eight rows now, recording what changed and
  never a value.
- **The people list and the channel list grew without bound.** Both were read in full on every render,
  and reading one person ran the whole people aggregate over the deployment twice per role change.
  Both are paged now, and the people screen searches on the server so somebody can be found without
  walking pages.
- **A computer accumulated one browser per Bot, forever.** `COMPUTER_MAX_BROWSERS` and
  `COMPUTER_BROWSER_IDLE_MS` set the two limits. Nothing closed an idle one, so a deployment
  where every employee has a Bot trends toward a resident Chromium per employee in one container until
  it is killed for memory. There is a cap and an idle timeout, and closing one costs only a relaunch
  because the profile is on disk.
- **The audit screen's filters were sequential scans.** It filters by event type, by who did it and by
  what it was done to, and the only index was on the timestamp, over what becomes the largest table in
  the deployment. Each filter leads its own index now.
- **A deployment with no identity provider came up open by default.** Covered under Changed above,
  and listed here too because it is the one on this list that was reachable from the internet.
- **Registering a company's identity provider was owned by whoever registered it.** Better Auth
  answers its own listing route with only the providers the person asking registered, and refuses a
  removal from anybody else, so a second administrator opened the Identity providers screen, found
  it empty, and registered one that already existed. Worse, the row cascaded from that person's user
  row: deleting the administrator who set sign-in up deleted the company's sign-in with them. What is
  registered is a fact about the deployment, so reads and removals go through OpenBot's own
  administrator-only routes against the whole table, and a provider outlives the person who added it.
- **A customer's client secret was in the clear.** The SSO plugin writes `oidc_config` and
  `saml_config` as plaintext JSON, with the OAuth client secret for that company's directory inside
  them: the one secret here not going through `KEY_ENCRYPTION_KEY`. Both are now encrypted at rest.
  Rows written before this still read, and are re-encrypted the next time they are written. OAuth
  access and refresh tokens use Better Auth's own encryption, keyed on `BETTER_AUTH_SECRET`.
- **A failed provider registration looked like a button that did not work.** The error was rendered
  on the page behind the dialog, which was covering it.
- **Deleting a component in the playground could release one the build ships.** `DELETE
  /api/sandboxed/:name` deleted from the shared components table by name, without checking
  which kind of component the name belonged to. Naming a compiled component removed its
  governance row, and the foreign keys took that component's per-Bot withholdings and its
  function grants with it. Withholding is the half that fails open: a published component is
  available to every Bot unless a row says otherwise, so the next catalogue announcement brought
  the component back published, and available to a Bot it had deliberately been kept from. The
  audit row called it `kind: "sandboxed"`. The endpoint now refuses a name this surface does not
  own and answers 404, the way publishing already did. A governance row whose source is already
  gone is still this surface's to clear.
- **A write could follow a symlink out of the Bot's workspace.** The confinement resolved the
  directory a write would land in but not the name it would land on, so a link left at `notes.txt`
  pointing outside was followed by the write; a read through the identical link was already refused.
  The gateway had already decided and written the audit row against the path as it was asked for, so a
  rule written for `credentials/` never saw the file that was written and the trail named a file
  nothing had touched. A dangling link escaped the same way, because resolving the path throws where
  the write would still land. Links pointing back inside the workspace continue to work.
- **A Bot could become root inside its container.** `sudo` was granted as `NOPASSWD: ALL`, and the
  comment above it named the two conditions that made that acceptable: the container being one Bot's
  alone, and not holding a database. The image meets neither, because the supervisor is deliberately
  not in it and `EMBEDDED_POSTGRES=on` is a documented way to run it. So root read another Bot's
  workspace, the API's environment, and the audit database recording what it did. The grant now names
  the package managers, so `apt-get install` still works and `sudo cat /proc/1/environ` does not. It
  is a floor rather than a boundary: code a model wrote needs a computer per Bot with
  `COMPUTER_SUPERVISOR_URL` and a sandbox under it with `COMPUTER_RUNTIME=runsc`, both of which this
  already supports and neither of which the single-container image can reach.
- **A command could take the computer down, or outlive being stopped.** Output was accumulated in
  full and only trimmed at the end, so `cat` of a large file allocated until the process that owns
  the browser died; it is now bounded as it arrives, and still reports that it was truncated rather
  than quietly ending. A stop signalled bash alone, so `sleep 30 | cat` left its children holding the
  pipes and the call never returned; the whole process group is signalled now. A `timeoutMs` of zero
  or less killed the command before it started and called it a timeout; it has a floor as well as a
  ceiling.
- **Stop did not reach a running command.** The `/exec` route never took the person's abort, so the
  plumbing for it was dead code and a stopped run left the command finishing inside the container.
- **The live-screen socket did not check the address it was given.** Every acting path resolved
  through the gateway, which refuses a foreign or cloud-metadata address; this one asked the provider
  directly and then put `COMPUTER_TOKEN` in the query string of whatever it was told.
- **`COMPUTER_SHELL_ENV` refuses the names that run before a command.** Naming `GITHUB_TOKEN` is an
  operator deciding a Bot may use a token. Naming `BASH_ENV`, `ENV`, `LD_PRELOAD` or the shell option
  variables is handing a Bot a hook into every later command, which is unlikely to be what was meant,
  so those are refused and said out loud rather than passed. A name that is not a variable name is
  now reported too, instead of quietly disappearing.
- **A deny rule naming one field refused every action that did not have it.** `deny:
  contains(command, "rm -rf")`, the example the documentation gives, refused every click, keypress,
  navigation and file read in the deployment. Two correct behaviours combined into a wrong one: the
  policy context left out fields an action did not have, cel-js treats a missing field as an unknown
  identifier and throws, and a thrown deny counts as a match so that a mistyped deny refuses rather
  than quietly permitting. Every field is now bound, with a neutral value where the action has
  nothing to put there, so a rule about a shell answers honestly about a click instead of refusing
  it. Rules about the action they are for are unchanged. The audit row still omits what did not
  happen.
- **A command longer than 45 seconds reported failure while it carried on running.** The transport
  gave every call the same deadline, which was shorter than the shell's own 120 second default and
  600 second maximum, so `apt-get install` told the person the computer had not responded and then
  finished installing inside the container. A command now gets a deadline that outlasts the shell,
  which reports a timeout itself and says so.

- **A Bot's shell no longer inherits the deployment's environment.** Commands ran with the computer
  process's own environment, so `env` in the one-container image printed `KEY_ENCRYPTION_KEY` and
  the rest of `.env`. The shell now receives PATH, locale and terminal names, and the proxy
  variables. Userinfo is stripped from a proxy URL, so a password in `HTTP_PROXY` is not in `env`.
  Anything else is named in `COMPUTER_SHELL_ENV`.
- **A deployment served over plain HTTP could not start a conversation.** The chat surface minted
  identifiers with `crypto.randomUUID`, which browsers withhold outside a secure context. On a
  laptop `http://localhost` counts as one, so this never showed up in development; on a real
  address it does not, and the surface did nothing at all when you pressed send. No message, no
  error. Ids now come from an API with no such restriction.
- **A Bot asked to be signed in, in words, and nothing happened.** Handing over the browser is a tool
  call, and a sentence in the transcript is not one: "please sign in and let me know" leaves the
  person with no wheel to take and the page where it was. Bots wrote that sentence anyway, and one
  went further and asked for a username and password to be typed into a sign-in page nobody could
  reach. The guidance now says that calling `computer_request_help` is what asking means, names the
  sentences that are not it, and says the person cannot see the page at all until control is handed
  over. Asked to file an issue on a site it was not signed in to, a Bot now offers the wheel on the
  first attempt instead of the third.
- **A package Bot did not know it had a computer.** The instructions that make the computer usable —
  snapshot before acting, and ask a person to take the wheel at a sign-in rather than reporting the
  task as impossible — were imported by the two shipped Bots and by nothing else, so a built-in agent
  knew only the role its package gave it. The tools were on offer to it the whole time. Asked to file
  an issue on a site it was not signed in to, it browsed to the page, said it could not, and never
  called `computer_request_help`, so nobody was ever offered the wheel. Built-in agents are now told
  the same thing the shipped Bots are told, wherever a computer is configured.
- **A chat could quietly forget everything and carry on.** The browser remembers a thread id for each
  Bot, and nothing ever asked whether Intelligence still had that thread. Where it did not, the
  transcript loaded empty, every later message silently recreated an empty thread under the same id,
  and the Bot answered as though the conversation were new — with the reason nowhere but the server
  log, as a 404 flattened into a 500 by the time it reached the browser. A remembered thread is now
  checked before it is used: one the platform provably does not have is replaced, because there is no
  conversation left to lose, and a check that fails for any other reason keeps the thread and says on
  screen that earlier messages could not be loaded. A person reading a confident answer can now tell
  whether the Bot has read what came before it.
- **The first browser action a Bot was ever asked for failed.** Creating a computer and starting it
  are two calls to Docker, and a name the daemon has not published yet answers the second with a 404.
  The supervisor treats that as a lost race and rebuilds, which is right, but it went straight back
  round: the retry landed a millisecond later, saw the same unpublished name, and spent the only
  other attempt on it. The whole request then failed as Docker being unreachable, the person was told
  the computer could not be started, and the next message worked. It waits one poll interval before
  rebuilding now, which is what the health wait already uses for the same question.
- **A framework Bot asked for a browser action and nothing happened.** `agent-langgraph` ends a run
  when the model calls a tool the surface owns, which is how a tool that lives in the browser is
  supposed to work: the run finishes, the surface acts, and the next run carries the result. But the
  call was only reported to the surface from the node that executes this deployment's own tools, and
  that node is exactly what an ending run skips. The person saw their own message, no answer under
  it, and no explanation, because a run that finishes carrying nothing is not an error. Every Bot
  action in the browser was affected: opening a page, filling a form, asking for help at a sign-in.

### Changed

- **A retention policy for the audit trail.** `AUDIT_RETENTION_DAYS` removes rows older than the
  window it names, swept hourly by whichever server holds an advisory lock. Unset by default, because
  deleting somebody's audit trail because a default said so is the worse of the two failures. The
  trail stays append-only: the database permits a delete only when the transaction declares a
  retention window and only for rows already outside it, so removing recent rows is still impossible
  and an `UPDATE` still is under every condition.
- **`allowed_groups` is documented as a declaration, not a control.** The tenant package writes it and
  nothing reads it on any access path, and `users.groups` is written by nothing either, so both halves
  of the rule are waiting on group membership arriving from the identity provider. Channel access is
  membership alone. The columns stay, because they are the right shape for the rule they are named
  for. Thanks to [@NathanTarbert](https://github.com/CopilotKit/OpenBot/pull/92) and
  [@andreolf](https://github.com/CopilotKit/OpenBot/issues/82).
- **Running with no sign-in takes a flag and nothing else.** It used to be locked with
  `NODE_ENV=production`, which is exactly backwards: `NODE_ENV` is unset unless somebody sets it, so
  a container on a VM with a hand-written env file and no identity provider served every visitor on
  the internet as an administrator, silently, because nothing looked wrong from the outside. A
  deployment with no provider now refuses to start unless `OPENBOT_SINGLE_USER=true` says it was
  meant. `.env.example` ships that line switched on, so a clone still runs with no configuration at
  all, and the line is greppable in a way a default never was. `OPENBOT_DEV_NO_AUTH` is still
  honoured.
- **Requires Better Auth 1.7**, which adds an `issuer` to every account. Migrations `0002` and `0003`
  add the column and backfill existing rows with their provider's real issuer, so nobody is asked to
  sign in again. The column stays nullable on purpose: a rolling deploy runs migrations and then
  serves from old and new replicas at once, and an old replica writes an account without it, so
  making it required in the same release would break the first sign-in of everybody who landed on a
  replica that had not been replaced yet. The constraint belongs to a later release.
- **Where a Bot's computer runs is now a plug.** One `ComputerProvider` interface sits under the
  gateway, with the Docker supervisor as one implementation and a shared computer as another. A
  computer somewhere else is an adapter rather than a change to the governed path. Thanks to
  [@mu-hashmi](https://github.com/CopilotKit/OpenBot/pull/57) for the refactor.
- The address a provider hands back is checked before anything is sent to it, and the cloud metadata
  addresses are refused whatever a provider says.
- The container image runs as an unprivileged user rather than root.

## 0.0.1

First tag.
