# Composio

Composio is a broker. It holds people's accounts for a few hundred apps — Slack, Linear, Gmail,
HubSpot and the long tail behind them — and publishes each app's actions as tools this deployment
can call on somebody's behalf. There is no OAuth client to register, no secret to paste and no
redirect URI to match character for character, because the account does not live here: the person
consents to Composio, and Composio holds what comes back. A Bot with a brokered action granted
reaches the app **as the person asking**, the same as every other per-person connector here, so two
people asking the same question get the answers their own accounts can see.

Setting it up takes three hands, and none of them can do another's:

| Who              | Does                                   | Where                                                            |
| ---------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Whoever deploys  | Sets `COMPOSIO_API_KEY`                | The deployment's environment. There is no screen for it           |
| An administrator | Enables an app                         | `/admin/plugins/composio`                                         |
| An administrator | Grants its actions to a Bot            | `/admin/plugins/composio-<slug>`, then that page's per-Bot screen |
| Each person      | Connects their own account to that app | `/settings/connected-accounts`                                    |

The key is the row that is easiest to misread, so it is stated twice: it is an environment variable
and nothing else. No administrator, however permissioned, can turn Composio on from a page, and
`/admin/plugins/composio` is where a key that is already set gets used rather than where one is set.

There is deliberately no endpoint for an administrator to connect an account on somebody's behalf.

## The key

`COMPOSIO_API_KEY` is one key for the whole deployment, and it is optional. It is the only Composio
setting there is — nothing per app, nothing per person. One key does not mean one shared account:
Composio keeps people apart by a user id sent with every call, so one person's connections are never
reachable from another's.

Nothing validates the key at startup. There is no shape to check it against and no call worth making
at boot to find out, so the first real request is what says whether it works. `composio:smoke` below
is how an operator asks that question deliberately rather than by watching somebody else fail.

Unset is a supported, fully described state rather than a degraded one: it is what every deployment
is today. What is on screen with no key is exactly one row, on `/admin/plugins` under the **More
apps** heading, titled *Composio* and reading *Add your Composio key to enable a catalogue of tools.
Set COMPOSIO_API_KEY on this deployment.* It has no chevron and it is not a link, because there is
nowhere to go until the key is set. It names the setting rather than hiding the feature, so an
administrator who has heard of Composio can find out what it wants — and because the heading above
it stays too, the handful of reviewed connectors does not read as the whole story.

That row is the whole of it. There is no directory to browse, no picker, no brokered app on
anybody's connected-accounts page, and no Composio tool for a Bot to call.

An app enabled while a key was set and then left without one keeps its row and its grants. Its page
says the key is missing, and its calls refuse with a sentence saying the same — distinguished, as
everywhere else here, from "the app advertises nothing".

### Asking what this key can see

```
COMPOSIO_API_KEY=... bun run composio:smoke -- --user <id> [--call]
```

`scripts/composio-smoke.ts` is the one command to run when Composio misbehaves and nothing on screen
says why. It ships inside the container image, so it is run where the key is — in the deployment,
not on a laptop — and it answers the question no page can: whether *this* key opens *this* project. A
key with no project behind it, a project with no authorization config for the app, and a person who
never finished the consent page all leave a product that looks configured and answers nothing.

**It separates the key from the person, which is two of those three and not all of them.** The
catalogue read answers for the key: a key Composio rejects, and a project whose catalogue does not
carry the app, both stop the run with the vendor's own sentence. The connection read answers for the
person. What it does not separate is the authorization config — an app no administrator has enabled
here has no config for anybody to connect against, so it reads exactly like a person who never
finished consenting, and the no-connection line says so rather than blaming the person. Check the
app's page under `/admin/plugins` to tell those two apart; enabling an app is what creates the
config. Making the script itself distinguish them would need a read-only auth-config listing on the
broker seam, which does not exist yet — the seam has `ensureAuthConfig` and `deleteAuthConfig`, both
of which write, and a read-only diagnostic must not create the object it was asked to look for.

**It names every app's resolved connection kind, and tallies the kinds, because a silent failure
lives exactly there.** One line per app carries the slug, the kind this deployment resolved it to
and its action count — and for a `fields` app the scheme too, `fields: API_KEY`, because which of
API_KEY, BASIC, BEARER_TOKEN or BASIC_WITH_JWT an app resolved to decides what the connect form
asks somebody to type. The kind is read off the catalogue row rather than derived a second time
here, so a diagnostic can never disagree with the product about how an app connects. Under the
lines is a tally: `Kinds: consent 121, self-registering 86, fields 1243, no auth 34, unsupported
56.` Every known kind is seeded at zero so the zeros print, which is the whole point of it —
resolution reads a malformed `auth_schemes` as an empty list, so a vendor renaming or reshaping
that field resolves *every* app to `unsupported`, and the picker hides unsupported apps. From
every other angle that failure says nothing: the catalogue lists its usual four figures, the
directory answers 200, not one app is offered. `Kinds: consent 0, self-registering 0, fields 0,
no auth 0, unsupported 1540` is that state, and it reads as one without anybody scrolling. The
per-app lines are what to grep afterwards for the app the report was run about.

It is all reads. It mints no connect link and starts no session, because a link is a bearer
capability and a diagnostic that printed one would leave somebody's mailbox in a terminal scrollback.
The key is never printed either: every line goes out through a redactor, including the vendor's own
sentences, which are the only lines carrying text nobody here wrote. `--user` takes the id this
deployment sends Composio as the person a call is for — the same id `composio_connections` records.
`--call` additionally runs one read-only action, `GMAIL_GET_PROFILE`, and only after checking
Composio's own behaviour label at call time rather than trusting the name.

**Which stream a line goes to is decided by the exit code it explains.** A line that explains a
non-zero exit is written to stderr; every other line is written to stdout. So `… > report.txt` keeps
a report of what the key can see while every reason the command failed is still on the terminal
beside it — and an action that ran and failed puts its outcome and its log id on stderr, because
those two lines are the whole explanation of the `1` it exits with. The exit codes are `0` for a run
that finished, `1` for a run that stopped, and `2` for a missing `--user`.

## What an administrator does

### 1. Find the app, and read its action count

At `/admin/plugins/composio`, search Composio's directory. The directory is read to its end — page
by page, following Composio's own cursor — and searched in this process rather than at the vendor,
so what is on screen is a whole listing and not a page of one.

**It is the whole CONNECTABLE listing, which is not the whole catalogue.** The apps that want an
OAuth application registered by whoever runs this deployment are filtered out before the search
runs: 56 of the 1540 apps Composio published on 2026-09-13, hidden because there is nowhere here to
put a client id and secret, and an **Add** button that could only ever meet a refusal is worse than
an app that is honestly absent. Every other kind is offered. What each of those kinds asks, and of
whom, is the section after this one.

Each row carries the app's **action count**, and that number is worth reading before pressing
**Add**. Slack publishes 167 actions, 73 of them reads — several times more than a model handles
well. There is no cap: grants remain the only ceiling, so a large app is possible and merely never
accidental.

### 2. Enable the app

**Add** takes the slug, which has to be one the directory itself answered with — a slug that arrived
from a caller and was written into a row's url would become the app every future call runs in.

**The authorization config is created here, not on somebody's first click, and it is created
first.** The SDK's own one-call shortcut would have made one on demand, at Composio's managed
defaults and under a name of its choosing, the first time any person pressed Connect. Creating it at
enable time, named for this deployment, makes it an object an operator can see in their Composio
dashboard from the moment the app exists — and tighten there, without a code change. It comes before
anything is written here, so a failure leaves no row behind and pressing the button again is the
whole recovery. Which KIND of config is created depends on how the app connects, and the app that
needs no authentication gets none at all, because Composio refuses to hold one for it — that is the
next section.

An account is then attached **against that config**, whether by a link minted for a consent screen
or by a key somebody types, which is why nothing mints a config later: an app whose config was
deleted at the dashboard refuses at Connect, naming the administrator's step, rather than quietly
acquiring a second one that nobody here named or can find.

Then one ordinary `mcp_servers` row — id `composio-<slug>`, url `composio://<slug>`, provenance
`composio`, vendor Composio, title from the directory, and no credential of any kind — and then the
app's actions, recorded with each one's effect, destructive marker and version, so a bad key is
reported to the administrator who just pressed the button rather than the first time a Bot calls
something. The audit row is the existing `configuration.changed` / `mcp_server_added`, marked
`provenance: "composio"`.

Nothing arrives switched on. Enabling an app names no Bot, and a switch drawn in the on position for
a grant nobody made is the one thing this codebase is most consistently careful about.

### 3. Grant actions to a Bot

Enabling the app gives no Bot access to it. From the app's page at `/admin/plugins/composio-<slug>`,
open one Bot to get a screen listing every action with a switch each — searchable, split into reads
and writes, with *turn on every read-only action* as the one bulk action, which says how many tools
that Bot will then carry before it does it. Every call then checks the grant, evaluates the action
policy, and writes an audit row.

A destructive action renders as danger. Nothing renders as reassurance: an action that does not
claim to be destructive is not claiming to be safe, so the absence of the marker is drawn plain,
never as green.

## The four ways an app connects

Composio's catalogue is not one flow wearing one name. Some apps end at a consent screen the person
has seen a hundred times; most end at a box asking for an API key they have to go and find; a few
ask nothing of anybody at all. Measured against the live catalogue on 2026-09-13, 1540 apps:

| Apps | How it connects                                 | What it asks, and of whom                                      |
| ---: | ----------------------------------------------- | -------------------------------------------------------------- |
|  121 | Composio's own consent screen                   | Nothing of anybody here. Composio holds the credentials        |
|   86 | OAuth that registers itself                     | Nothing of anybody at all. A client is minted during consent    |
| 1243 | A secret the person already holds               | One to three boxes, typed by the person connecting             |
|   34 | No authentication at all                        | Nothing, ever. There is no account to make                     |
|   56 | An OAuth application registered by the operator | Not offered here at all — see the last section below           |

**Only the first row of that table used to work.** Every authorization config was created as
`use_composio_managed_auth`, which is the right object for the apps Composio itself holds developer
credentials with and the wrong one for everything else. For a self-registering app the failure was
loud — Composio has no client of its own to manage, so it answered 404 and the app simply could not
be added. An app that needs no authentication failed in the vendor's own words, because Composio
will not hold a config for one at all. And for a key app it was quiet and worse: the config was
accepted, and every person enabled onto it was then sent to a consent screen that had nothing to ask
them for.

**Which kind an app is, is derived once and then recorded.** The derivation reads what the catalogue
already publishes — `no_auth`, `composio_managed_auth_schemes`, `auth_schemes` — and the picker and
the connect screen both read that one answer rather than each guessing for themselves. The order is
`no_auth` first, and that is not a preference: Composio refuses outright to hold an authorization
config for an app that needs none, so nothing else an app publishes beside it can be acted on. Then
managed OAuth, because it asks the person for nothing; then self-registering OAuth, which asks
nobody for anything; then a scheme whose secret the person already holds. Linear publishes managed
OAuth *and* an API key, and resolves to the consent flow for exactly that reason.

The resolved answer is written onto the app's row (`mcp_servers.auth_scheme`) when an administrator
enables it, and every later step — the form, the connect call, the disconnect sentence, the call
gate — reads the row rather than the catalogue. A connection is a lasting attachment to the
authorization config it was made against, so a vendor that starts publishing a new scheme for an app
next month must not move live connections onto a different flow. Pressing **Add** again therefore
does not rewrite the scheme, with one exception: where nobody has connected there is nothing to
strand, so the rewrite happens and is how an operator picks up a vendor's change without removing
the app.

### Composio's consent screen, and an OAuth app that registers itself

These two are one flow from here, which is why the earlier sections describe them without
distinguishing them: a link is minted, the person leaves for a page at Composio, and they come back
to a page this deployment chose. Nobody types anything and nobody registers anything.

They differ only in the object created at enable time. A managed app gets
`use_composio_managed_auth` and rides on the developer app Composio registered with the vendor. A
self-registering app gets `use_custom_auth` with `DCR_OAUTH` **and no credentials at all**, because
there are none to hold: the client is registered with the vendor at the moment somebody consents.
The 86 apps in that row need credentials from nobody — not from Composio, not from whoever runs this
deployment — and they were unreachable here purely because the wrong kind of config was being asked
for.

### A secret the person already holds

This is most of the catalogue, and it is the kind that has no consent screen in it. **Connect** on a
key app does not leave OpenBot: it asks Composio what the app wants, draws those boxes, and the
press after that carries what was typed in them.

The boxes are the app's own. Their names, labels, help text, defaults and which of them are secret
are published per app by Composio and used verbatim — one key for most apps, a key and a workspace
subdomain for Shopify, two values for Firecrawl — and the names are sent back exactly as they came,
because a name renamed on the way through is a box somebody filled in that no app ever reads. A
field Composio marks as not user-visible is not drawn. A field of any type other than text, or one
with no name at all, is a refusal rather than a box drawn blind: somebody typing a path into a box
labelled *Certificate* and being told they are connected is the failure that guard exists to stop.
A submitted name the app does not publish is refused too, rather than dropped — a stale form
connected with the half that still matches is an account every screen here draws as working.

**What is typed in is held by Composio and never by this deployment.** The values arrive on one
request, travel to Composio in the next call, and are gone when the handler returns. They are not
written to a table — `composio_connections` goes on being a row that names an app and a person and
nothing else — not to a log line, not into an error body, and not into the audit row, which records
the field *names* that were filled and never a value. The one rule this connector reverses for them
is its own: everywhere else a vendor's thrown object is carried along as `cause` because it holds
the request it was made for, and on this one call that request is somebody's key, so the adapter
reads the vendor's sentence and drops the object entirely. What that costs is the diagnostic trail
on the flow people most often mistype, and the cost is taken knowingly: what an operator gets is
Composio's own sentence and the request id inside it, which is what Composio's dashboard searches
on.

### A key is checked once, and the page says when

**Composio does not grade a submitted key.** A connection created with an obviously wrong value
comes back `ACTIVE`, and stays `ACTIVE` forever after. Left there, "connected" would mean "typed
something", and the first failure would arrive hours later inside a Bot's answer to somebody.

So a key connection is followed by exactly one call: a read-only, argument-less action the app
itself publishes, chosen by this deployment from the metadata recorded when the app was enabled and
never from anything a request said. Both conditions are load-bearing and neither implies the other.
Read, because a probe must not change anything — and "read" here means Composio labelled the action
`readOnlyHint`, since everything unlabelled is recorded as a write. Argument-less, because at that
moment nothing is known about the account beyond the key, so any required argument would have to be
invented, and an invented one turns *is this key good* into *does this identifier exist*. The two
together are not belt and braces: the first argument-less action on Stripe's own list is
`STRIPE_CREATE_BILLING_METER_EVENT_SESSION`, so a probe chosen on "takes no arguments" alone would
write to somebody's account to find out whether their key works. An identity-shaped name is
preferred where the app publishes one, and most apps publish some other safe read instead.

It is the only call in this deployment that reaches a vendor without a Bot, a grant check, a policy
evaluation, content inspection or an `mcp.call_*` row, because there is no Bot to check a grant for.
What keeps it narrow is structure rather than care. It has exactly two callers — the connect step,
and a person pressing **Re-check** on their own connection — and neither reads a person out of a
request body: the account probed is the session's own. The action is chosen by this deployment from
recorded metadata and never from anything a request named, and it carries no arguments, which is
also what leaves content inspection nothing to inspect. A probe that ran leaves an
`mcp.connection_verified` row naming the action and the verdict, so the calls that happened are
readable; the single exception is a bad key on a first connection, which is undone completely —
no account, no row, nothing for anybody to do — and files nothing, so that the rows which do exist
keep meaning *something is still standing here*. The consequence to accept knowingly is that this is
the first vendor call in this deployment attributable to a person rather than to a Bot, and queries
over that trail were written assuming otherwise.

What the page then says is the moment it last looked, never a present tense: *Connected with a key
you provided, last checked 13 Sep.* Three outcomes are possible and the page keeps them apart. The
probe ran and answered, and the row is verified as of that instant. The probe ran and the vendor
refused, and the account this connect just made is deleted at Composio **by its id** — not by app,
because ending every account somebody holds for an app is what disconnect means and the intent here
is only to undo what just happened — and nothing is recorded. Or there was nothing to try — the app
publishes no action that passes both conditions, or none at a version this deployment recorded — in
which case the key is kept and the page says it was accepted without being checked, which is the
honest sentence and not an apology for one. A person with a perfectly good key must not be told the
vendor rejected it because an app's listing was thin.

There is one state worse than those, and it has a sentence of its own for that reason: a key the
vendor refused, over an account that is still standing at Composio. Two paths arrive at it and they
arrive for different reasons. A connect whose probe failed tried to withdraw the account it had just
made and Composio would not take it back — and leaving no row then would not mean nothing was left
behind, it would mean a live account nothing on any screen names and the person cannot disconnect,
because disconnect works off the row. A re-check the vendor refuses never tried to withdraw
anything, deliberately: that account predates the press and is the person's own, so taking it away
in order to report a bad key would destroy the thing they came to repair.

Either way the row is written unverified and the person is told all three facts rather than left to
conclude their key might be fine: *Your key was checked against Perplexity and rejected, and the
account it was checked in still stands at Composio, so disconnect it here, or fix the key at
Perplexity and press Re-check.* What the sentence does not do is say **why** the account stands,
and the omission is deliberate rather than vague. Blaming a failed withdrawal is true on the connect
path and false on the re-check, where nothing ever attempted a removal; the standing account is the
actionable half on both, and which path wrote the row is not recoverable from it afterwards. Both
ways out are named because neither is obvious from a row that still reads "Connected": the account
ends with the button beside the line, and a key corrected at the vendor is worth a second check
rather than a second connection. An audit row naming the action that was tried records the same
state for whoever reads the trail a week later, because a sentence one person read once outlives
nothing.

**Which of the three a row is in is a fact about the action a check actually spent, and the page
keeps it across a reload.** The flag alone cannot say: `false` is both *this app published nothing
safe to try a key on* and *your key was checked and rejected and the account is still standing*.
So the connections read carries two fields beside the flag and the date, and they answer two
different questions. `probe` is the action the last check SPENT, written down by that check and read
back off the row — a fact about the past, and what the row's sentence is drawn from. `checkable` is
whether the app publishes anything safe to spend a key on TODAY, asked of the app and kept as a yes
or no — a fact about the present, and what the Re-check button is drawn from. Neither is a weaker
spelling of the other, and a screen that asks either of them the other's question breaks in the way
the other field exists to prevent. A re-check or a key just handed over names the action it was
actually spent on, and that answer wins over the recorded one, because an answer is a newer record
of the same thing and a check that has just run must not be overruled by a read taken before it. A
re-check the vendor refuses is not an answer at all: it is raised, and Composio's own sentence for
it reaches the person as a refusal rather than as a row that quietly changed its wording.

While the name was derived on every read, an administrator's Refresh could rewrite what a check had
found. Somebody connects a key to an app that publishes nothing safe to try it on, and the row
honestly says the key was accepted unchecked. Then an administrator presses Refresh, which is the
very press this transport tells them to make when an action appears or gains the version that makes
it callable. The derivation names an action, and from that page load on the row draws the sentence
written for a REFUSED key: checked and rejected, the account it was checked in still standing, so
disconnect it. Every clause of that is false for somebody whose key nobody had touched, it tells
them to take down a connection that works, and it persists until they press Re-check. The recorded
column is what puts that state out of reach: what a check spent is written by the check, and no
later reading of today's metadata can move it.

**Nothing re-checks on page load.** That call is spent on the person's own account and against their
own rate limit at the vendor, so verifying on every render would burn somebody's quota at Linear to
redraw one word on a page they were passing through. **Re-check** is a button, and it runs the same
probe against the account that already exists: it creates nothing, and a key the vendor rejects
leaves their account alone — it is the key that is wrong, and taking the account away would destroy
the thing they are trying to repair. It is drawn on a key connection and on nothing else, and the
one state it is withheld in is an app with nothing to check a key against today, where pressing it
could only ask for the same answer again. That question is asked of the app and never of the record:
a key accepted when the app published nothing records no action, permanently and correctly, and a
button withheld on that record stays withheld even after a Refresh has given the app something to
try — while pressing that button is the only thing in the product that could ever put an action into
the record. A key the vendor has just rejected keeps its button, because that is the person most
likely to have gone and fixed something.

### Disconnecting a key does not end it at the vendor

Disconnect promises that an account ends at Composio and not only here, and for a consent app that
is the whole truth: the grant dies at the provider. For a key app there is nothing upstream to end.
The account goes at Composio, and the key is still live at the vendor and still works for anyone
holding it — including whoever else it was already pasted into. So the sentence differs and names
the step this deployment cannot take: *Removed from Composio. Your key still works at Perplexity —
rotate it there if you meant to end its access.*

The audit row says the same thing in its own half of the sentence. `vendorRevocationRequested` is
`false` for a key connection by construction rather than by what the vendor found, because
`revoke_on_delete` asks a *provider* to end a grant and there is no grant behind a key to withdraw.
Recording otherwise would be the one thing that field exists not to do: claim a withdrawal nobody
asked for and nobody could have made.

### An app that needs no authentication has no account, and the gate has to know

Thirty-four apps need no authentication at all, and Composio refuses to hold an authorization config
for one of them — *"Cannot create an auth config for toolkit hackernews because it does not require
authentication."* Enabling such an app is therefore the `mcp_servers` row and its actions and
nothing else: no config, no consent, no account. Its row on a connected-accounts page says the app
needs none and carries no button, not even a disabled one, because there is no act to offer and a
greyed control announces a step somebody is missing when they are not.

**The call gate had to learn about this, and the alternative was worse than it looks.** A brokered
call is decided on one row: `(toolkit, user_id)` in `composio_connections` is the whole of the
permission. A no-auth app can never have one, so the gate reads the app's recorded scheme beside the
row it already loads and lets a `NO_AUTH` app through with none. Writing a row anyway would have
been the easy fix and would have poisoned the table: every row in it means *this person granted this
deployment access to their account at this app*, and that is how offboarding, the audit trail and
disconnect all read it. Rows where nobody consented and no account exists are indistinguishable, a
year later, from rows where somebody did.

### The 56 that are not offered

Fifty-six apps want an OAuth application registered by whoever runs this deployment — a client id
and a client secret, obtained from each vendor in turn, per app. They are filtered out of the
picker, so an administrator never meets an **Add** button that cannot work; where one is reached
anyway, the refusal comes before anything is written and names what the app is asking for.

They are hidden here rather than at the vendor, because the filter is a fact about what this
deployment can drive and not about what Composio publishes. **A screen to hold a client id and
secret for a brokered app is a deliberate non-goal, and this sentence exists so that its absence
does not read as an oversight.** The whole argument of this connector is that there is no OAuth
client to register and no secret to paste, and an app that requires both is asking for the thing the
broker was adopted to avoid. One app in thirteen was connectable before this change; these 56 are
what is left out now, and they are named here so that an operator who goes looking for a Slack-like
app and does not find it knows which question they are asking.

## What each person does

At `/settings/connected-accounts`, a brokered app appears beside the OAuth connectors once an
administrator has enabled it. Open it and press **Connect**. On a consent app — and on one whose
OAuth client registers itself, which is the same trip from here — that leaves OpenBot for Composio's
consent screen and returns to the same page, or, for an administrator who started from the app's own
page under `/admin/plugins`, back to that page, because leaving a page mid-task and being returned
to a different one is the round trip this exists to remove. On an app whose secret the person
already holds, **Connect** goes nowhere: it opens a form and asks for it. The rest of this section
is about the trip; the section above is about the form.

**The address they come back to is built here, and a caller has no say in it.** It is this
deployment's `OPENBOT_APP_URL` plus one of two known pages, so what a request can choose is which
page and never which site: an address taken from a body or a query would be an open redirect with a
consent screen in front of it, which is the same reason this deployment's own OAuth flow narrows its
`returnTo` to a name. A deployment with no app URL configured has no absolute address to hand over
— the consent screen is on Composio's origin, so a relative one resolves against theirs — and
**Connect** refuses there, naming the setting, rather than minting a link that would strand somebody
on Composio's page having just granted access to their mailbox.

**The link is yours alone.** It is minted for the session's own id and can be asked for on nobody
else's behalf. It is a bearer capability — whoever opens it binds *their* account to the id it was
minted for — so it is handed to the browser that asked and is never stored, logged, audited, or put
anywhere a second person could read it. Do not forward it.

Coming back does not by itself grant anything. The return trip is an ordinary redirect with nothing
signed in it, so the row that lets calls through is written only after Composio confirms the account
is live. The page asks on return, and asks again on load, so a row that drifted heals. Composio is
the source of truth and the row here is a cache of it.

**A failure at Composio arrives as Composio's own sentence.** A wrong key, a revoked one, an app
whose authorization config was deleted at the dashboard: each of those comes back as the one
sentence the vendor wrote — *Invalid API key provided.* — with everything that travelled beside it
left where it was. The key never appears anywhere, nor the connect link, nor the vendor's thrown
object, which is an entire HTTP response including headers and trace ids. Where the vendor reported
a failure and said nothing about it, the sentence is this deployment's own and names the step to
take rather than echoing a placeholder.

**One account per person per app, and the second is refused.** Composio would happily hold several
accounts for one person and one app, but the call that runs an action names the person and not the
account — so with two Gmail accounts connected, which mailbox a Bot reads would be Composio's
choice, and neither the table here nor the audit row could say which one it was. Connect therefore
refuses while a live connection for that app already exists, and names the way to switch: *You
already have an account connected to Slack. Disconnect it first if you want to connect a different
one.* The app's own title, never the row's id. It is per app and nothing more — Gmail and Linear and Notion connected alongside each other are untouched.

### Disconnecting

**Disconnect**, on the same page, revokes at Composio first and deletes the row second. The account
ends at Composio, not just here — which, for an app whose secret somebody typed, is all it can end,
and the page says so rather than letting *disconnected* be read as *revoked*. Revoke-then-delete is
the ordering everywhere in this connector, so a failure between the two leaves access dead rather
than live and unreachable; pressing Disconnect again is the whole recovery. Audited as
`mcp.account_disconnected`.

## The two paths that end somebody else's access

Both of these used to stop at this deployment's own tables, which was the only thing they could do
while there was nothing to revoke with. Both now reach the broker.

**Removing the app** revokes every person's connection to it at Composio, clears the rows, and then
deletes the authorization config that enabling created. For an app whose secret people typed, that
withdrawal again reaches only as far as Composio: their keys stay live at the vendor, and nobody is
told to rotate one, because nobody here is looking at the screen. Re-adding the app afterwards starts empty
rather than silently restoring everybody who had connected before.

**Removing the person** revokes each of their brokered connections at Composio before clearing the
rows, and reports what was revoked. The `composio_connections` table is keyed on
`(toolkit, user_id)` and outlives the user record for exactly this reason — so offboarding can still
find the connection after the person is gone.

## What the grants narrow, and what they do not

The authorization config keeps Composio's default scopes. Narrowing them properly would mean
choosing scopes before anybody has been granted anything, which is backwards, so it is not done
pre-emptively. Stated plainly:

> **The vendor-side grant is as wide as Composio's own app asks for, and this deployment's grants
> are the entire narrowing.**

This page is where that is stated. The app's own screen does not repeat it — worth knowing, because
an operator who reads only the screen will not meet it.

This is the position Notion is already in. What keeps a Bot's reach small is which actions are
switched on for it, and nothing at the vendor stands behind that.

## Blast radius

One vendor ends up holding every person's connection to every app — which is the deal any broker
offers, and should be chosen rather than discovered.

## Not built yet

**No approval step before a destructive action.** The destructive marker is recorded and now
visible, but it gates nothing: a Bot granted a destructive action performs it without anybody being
asked. That is the same position every other connector is in — but it is now a position reachable
through the UI rather than only through a database insert, which is a real change in exposure.

**No way to give a Bot a whole large app to search.** A Bot carries the actions somebody switched on
for it, one at a time. There is no search-and-run path for an app too large to tick through, which
is why an app's action count is worth reading before it is enabled rather than afterwards.

## See also

- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — `COMPOSIO_API_KEY`, and that it is optional.
- [Notion](notion.md) and [Google Drive](google-drive.md) — the same per-person shape, with the
  OAuth client registered here instead of held by a broker.
