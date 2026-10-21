# Arcade

Arcade is a broker, the same kind of thing Composio is: it holds people's accounts at other apps —
Gmail, Google Calendar, GitHub, Asana and more — and publishes each app's actions as tools this
deployment can call on somebody's behalf. A Bot with a brokered action granted reaches the app **as
the person asking**, so two people asking the same question get the answers their own accounts can
see. Where Arcade differs from Composio is the part an operator has to set up: **an Arcade project
needs an OAuth app of your own for every provider, and one manual step in Arcade's dashboard.** This
page is about those, and about what to tell somebody when a connection looks wrong.

Read [Composio](composio.md) first if you have not: what a broker is, what Personal and Shared mean,
the approval rules and the audit trail are the same here and are not repeated.

Some things on this page are stated as **unproven**, and the last section lists them. What is
marked _measured_ was observed by hand against a live Arcade project during development, in two
rounds, and **nothing in CI dials Arcade** — the vendor's behaviour can change without any check
here noticing:

- **Before this page was first written (2026-10-12)**, with a throwaway script that is not in this
  repository: the toolkit classification counts, GitHub's 43 of 43, Google's first 11 of 30, and the
  default-verifier failure below.
- **Once, on 2026-10-13**, with `server/tests/arcade-live.test.ts` (`ARCADE_API_KEY=… bun run
  test:live-arcade`), which drives this deployment's Arcade adapter against the real API with a
  stand-in for its verify route, and needs a person at a browser to consent: the `provider_id`
  shapes, the shared Google connection, Google's 0 → 11 of 30, and the wrong-user answer. That run
  came back 9 passed, 3 failed — all three the suite's own mistakes, corrected afterwards from what
  it measured — and the corrected suite has not been run since. Without a key every case in it
  skips, which is what CI does.

## Who sets what, and where

Setting it up takes three hands, and none of them can do another's:

| Who              | Does                                                         | Where                                                             |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Whoever deploys  | Sets `ARCADE_API_KEY`                                        | The deployment's environment. There is no screen for it           |
| Whoever deploys  | Sets `OPENBOT_BROKER_PROVIDER`, only where both keys are set | The deployment's environment                                      |
| Whoever deploys  | Registers an OAuth app per provider, and sets the verifier   | Arcade's dashboard, below                                         |
| An administrator | Enables an app and grants its actions to a Bot               | `/admin/plugins/arcade`, then the app's own page, as for Composio |
| Each person      | Connects their own account to that app                       | `/connections`                                                    |

The key is an environment variable and nothing else, as Composio's is. No administrator can turn
Arcade on from a page; `/admin/plugins/arcade` is where a key that is already set gets used.

### Choosing the provider

A deployment runs one broker at a time. `OPENBOT_BROKER_PROVIDER` takes `composio` or `arcade`, and
anything else stops the server at startup.

**Where exactly one of the two keys is set and the variable is unset, that provider is the active
one, so no existing deployment has to set anything.** The variable matters only when both keys are
set. Setting both is legal and expected, because ending an account at the old vendor needs that
vendor's key. With both set, the variable has to say which one is live: both set and the variable
unset stops the server at startup rather than coming up with no broker at all.

**Connections already made are still read as their own provider's while nothing is active.** A
deployment whose broker key has been withdrawn afterwards names the slice it reads from the
`brokered_connections` rows it actually holds, so an Arcade deployment does not have its Arcade
connections read as Composio ones, shown as absent, and left unrevokable. No broker is live in that
state, so nothing can be connected or revoked until a provider is named. Holding rows at BOTH
vendors with nothing active is refused rather than guessed at, which is the activation refusal from
the other side. (Both keys set with the variable unset does not reach this: that state is refused at
startup, above.)

Four refusals protect this, and all four are deliberate:

- **A named provider whose key is not set stops the server at startup.** An operator sees: _OPENBOT_BROKER_PROVIDER=arcade names a provider whose ARCADE_API_KEY is not set to a key. Set ARCADE_API_KEY to this deployment's key, or change or unset OPENBOT_BROKER_PROVIDER._ It does not fall back to a deployment with no broker, because that would send somebody looking for a broken vendor instead of at their own environment. A key that is empty or all whitespace — `ARCADE_API_KEY=` with nothing after it — is no key: that provider counts as unconfigured, and no client is ever built on an empty credential.
- **Both keys set with the variable unset stops the server at startup.** An operator sees: _COMPOSIO_API_KEY and ARCADE_API_KEY are both set and OPENBOT_BROKER_PROVIDER is unset, so no provider is active and nothing brokered would work. Set OPENBOT_BROKER_PROVIDER to composio or arcade to say which vendor is live, or unset the key of the vendor this deployment is not using._ Nobody wants that state on purpose — the deployment would hold two vendor keys and broker nothing — and wiring no broker silently would surface much later and far away, as brokered features that simply do not work. "Both set" counts only keys that hold something: two blank keys are no keys, and are reported as such rather than as two configured vendors.
- **Activating a provider is refused while the other one still holds connections.** It is keyed on connection rows, not on keys. The message names the provider being activated and how many connections still belong to the other. Switching by editing the environment would leave accounts nobody can revoke. **There is no one-step migration**; what ends the old provider's connections today is keeping it active — both keys set, `OPENBOT_BROKER_PROVIDER` naming the old provider — and using the ordinary ways a connection ends, each of which revokes at the vendor and deletes the row: each person disconnects their own on `/settings/connected-accounts`, an administrator disconnects a Shared app's account, an administrator removes an app (which ends every account connected to it), or a person is offboarded. When the old provider holds no connections, name the new one and restart.
- **Holding connections at BOTH providers while nothing is active stops the server at startup.** It is the refusal above seen from the other side: with no provider named there is nothing to read one vendor's rows as, and reading them as the other's is the failure this whole section exists to prevent. The message names both vendors and says plainly that **nothing in the deployment can get past this**: with rows at both, activating either provider is refused by the rule above. The only way out is by hand — end one vendor's accounts in that vendor's own dashboard, delete its rows from `brokered_connections`, then name the other provider. The refusal at activation exists so that this state is never reached.

## Setting up the Arcade project

### One Arcade project per deployment

Create one Arcade project for each deployment, and do not share. The verifier URL (below) is a
setting of the **project**, and a staging deployment and a production deployment have different
addresses, so they cannot both be pointed at by one project's setting. A project shared between them
would have its verifier pointing at one and failing for the other.

### An OAuth app of your own, per provider

**Arcade's preconfigured providers cannot be used.** Register your own OAuth app at each provider
(Google, GitHub, and so on) and give its client id and secret to Arcade as that provider's
configuration.

This was confirmed the hard way, and the reason matters because it is not a preference. A consent
link was minted for an arbitrary `user_id` against Arcade's default Google provider. It **failed at
verification** with _"the authorization process was not completed"_. The same consent minted for an
Arcade project member's own identity **completed**. Arcade's built-in verifier has to recognise the
end user as a member of the project, so it can only serve a `user_id` that is one. Per-person
connections in OpenBot are arbitrary ids by definition — nobody is made a member of your Arcade
project in order to connect their mailbox — so a default provider cannot serve them at all.

Arcade's admin API can create the OAuth provider, so that part can be scripted.

> **Decide about the agentic-client checkbox deliberately — unproven.** Google's console offers
> _"Use this client for an AI-powered agent"_ on an OAuth client. It is a self-declaration, and
> ticking it puts that client under a separate administrative-policy surface; Google's own advice is
> to register separate client ids for human workflows and agent workflows. Every brokered call
> OpenBot makes is agent-initiated, so this is a choice a deployer should make on purpose rather
> than leave at its default. **It was not exercised:** the client used for the measurements on this
> page was registered with the box left unticked, deliberately, to keep a policy variable out of the
> measurement. What ticking it changes in practice is therefore not known here.

### The verifier URL is the one dashboard-only step

**The verifier URL cannot be automated.** It is set by hand in the Arcade dashboard, on the project,
and there is no API that does it. It is the single manual step in setting Arcade up, and it is the
one that is easy to do wrongly, so it is stated here rather than left to be discovered.

Set it to this deployment's verifier address, then switch the project to a custom verifier. The
address is this API's public origin — `OPENBOT_PUBLIC_URL`, which defaults to `BETTER_AUTH_URL` —
followed by the path, so paste:

```
<this deployment's public origin>/api/plugins/arcade/verify
```

It is the API's origin, not the browser app's, where the two differ. A browser that arrives there
is sent on to the Connections page, with a reason beside it if the consent was refused.

**Nothing checks this setting, so the deployment warns about it instead.** Arcade has no API that
reads which verifier a project uses, so this deployment cannot tell a correctly pointed project from
one left at Arcade's default. Every time it starts with Arcade active it logs a warning naming the
exact address to set — built from `OPENBOT_PUBLIC_URL` (or `BETTER_AUTH_URL`) — and pointing here.

**If the project is left at Arcade's built-in verifier, this deployment's verify route is never
called.** That route is the return leg that binds a consent to the attempt that started it, checks
that the identity returning is the one the attempt was minted for, records the connection and files
its `mcp.account_connected` audit entry. None of that happens, and nothing in this deployment's logs
says why. What was observed by hand (see the top of this page) is that Arcade's built-in verifier
refuses a consent for any `user_id` that is not a member of the Arcade project — and the ids this
deployment sends are its own internal ids, not project members — so in practice **nobody can
connect**: the person is left on Arcade's
page with _"the authorization process was not completed"_. A consent that does complete at Arcade
that way is bound to no attempt; the Connections page may later record it when it asks Arcade
whether the person is connected, but without the identity check the verify leg exists to make.

> **Do not save the custom-verifier setting without a URL.** It switches off the path that currently
> works and switches on nothing — and it presents as _this deployment's own code failing_: consents
> that used to complete stop completing, with nothing in this deployment's logs to explain it. It is
> the trap an operator will otherwise spend an afternoon on. If connections stop completing and
> nothing here changed, look at the project's verifier setting before anything in this deployment.

## What an administrator does

The shape is Composio's: enable an app, grant its actions to a Bot, and each person connects their
own account (or an administrator connects a Shared app's account). Two things are different and
worth reading before pressing **Add**.

### Toolkits are curated or they are wrappers, and the difference was measured

Every action carries a classification — whether it reads or writes, whether it is destructive — and
what OpenBot asks before running it depends on that classification. Arcade publishes it as
`metadata.behavior` on each tool, and toolkits fall into two groups:

| Toolkit     | Tools              | With `metadata.behavior` |
| ----------- | ------------------ | -----------------------: |
| `Github`    | 43                 |                       43 |
| `Asana`     | 19                 |                       19 |
| `GithubApi` | 100 (the page cap) |                    **0** |

Curated toolkits classify every tool. Generated API wrappers classify none. An action that is not
classified is treated as a **destructive write**, because an unlabelled action is not claiming to be
safe. So an administrator enabling an unclassified toolkit is warned **before** finishing that
**every call will ask for approval** — not because anything is wrong with the toolkit, but because
nothing in it can be told apart from a write that cannot be undone. Where a curated toolkit exists
for the app, enable that one.

## Least privilege is not an Arcade property

Do not tell anybody that Arcade gives least-privilege access. It is true for some providers and
false for others, and the same product is on both sides of the line.

Arcade asks for consent per action. What that consent _covers_ depends on whether the provider
issues per-request scopes. Measured by hand (see the top of this page), through a completed consent,
from a clean baseline:

| Provider                  | Scopes per action                                   | One read consent authorized | Isolation |
| ------------------------- | --------------------------------------------------- | --------------------------- | --------- |
| Google (`Gmail`)          | `gmail.readonly` vs `gmail.send` vs `gmail.compose` | **11 of 30**                | yes       |
| GitHub (via a GitHub App) | **none, for any action**                            | **43 of 43**                | no        |

The Google row was observed a second time in the one run of the live suite on 2026-10-13, through
this deployment's Arcade adapter, from a clean baseline and one real consent: before consenting,
**0 of 30** scope-carrying `Gmail` actions were authorized; after consenting to a single action
(`Gmail.GetEmail`), **11 of 30** — and **nothing outside the scopes that consent granted**. So
per-action isolation on Google held both times it was looked at, by hand; nothing re-checks it.

On Google, consenting to a read authorizes the reads that share its scope and nothing that sends.
On GitHub, consenting to `Github.CountStargazers` — **a read** — flipped all 43 actions to
authorized, **the writes and the destructive one included**, because a GitHub App's permissions are
fixed when the app is registered, and no request can ask for fewer.

> **Least privilege is a property of (provider × how its OAuth app was registered), not of Arcade.**
> What OpenBot does is **measure which it is, per app, and say so before anybody grants anything.**

So when somebody asks whether connecting an app "only lets it read", the answer is whatever that
app's measurement says, not what Arcade says in general. The pre-redirect consent copy names the
permission being asked for and lists the actions that share it, grouped on scopes.

## Scope versus tool grant

Two different questions are easily run together, and an operator will be asked both:

- **Scope** answers _"may this deployment ever read your mail?"_ It is the provider's, it is given
  when somebody consents, and it stays until it is withdrawn at the provider.
- **The tool grant** answers _"may **this Bot** call `ListThreads`?"_ It is an administrator's
  decision, made per Bot, per action.

**Only the second is OpenBot's to give and take instantly**, and no consent widens it. Somebody
consenting to a broad scope does not hand any Bot more actions; a Bot with no grant for an action
cannot call it however much the account allows. On a provider that cannot narrow scopes (GitHub
above), the tool grant is therefore the entire narrowing — the same position as Composio's.

## `provider_id` means three different things

An operator reading an Arcade dashboard, or an API response, or a refusal this deployment quotes,
will meet the field `provider_id` on three different objects — and it means something different on
each. _Measured_ in the 2026-10-13 live-suite run:

| Where you are reading it                            | What it is                                       | Example                              |
| --------------------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| A **tool** listing, `requirements.authorization`     | the provider **type** — the vendor               | `google`                             |
| A **user connection** row                            | the provider **instance** — a configuration      | `google-openbot`, `cpk-poc`          |
| An **auth provider** config                          | `id` is the instance, `provider_id` is the type  | `id: arcade-google` of type `google` |

The auth-provider config is the only bridge between the other two. Verbatim, from that run:

```
{"id":"cpk-poc",        "provider_id":"github", "type":"oauth2", "status":"active"}
{"id":"google-openbot", "provider_id":"google", "type":"oauth2", "status":"active"}
{"id":"arcade-google",  "provider_id":"google", "type":"oauth2", "status":"active"}
```

A connection row carries **no vendor-type field at all**. Its full key set, verbatim:

```
id, provider_type, connection_id, connection_status, scopes, user_id, provider_id,
provider_description, provider_user_info
```

`provider_type` there is `"oauth2"` — the auth **scheme**, not the vendor. So the instance id is the
only thing on a connection that says which vendor it belongs to, and the only way from a tool's
`google` to a person's row is through the list of configured providers of type `google`.

**This bit this deployment once.** A connection lookup compared a tool's type against a row's
instance — `"google"` against `"google-openbot"` — and so matched nothing on every real deployment,
Arcade's own default providers included, since those are named `arcade-google` and `arcade-github`
and never the bare type. It did not present as an error: a connection that existed read as
**not connected**, with no account name beside it. It is fixed, and it is written down here because
the same confusion is waiting for whoever next reads two Arcade objects side by side. **If a
connection you can see in Arcade's dashboard looks absent in OpenBot, check that the provider the
person connected under is one this project has configured** — a provider configuration deleted while
somebody's connection outlived it reads the same way, and deliberately so: OpenBot leaves a row it
cannot attribute alone rather than guess which vendor it belongs to.

## Disconnecting one app may end another

Arcade's connections are per **auth provider**, not per app, and the sharing was _measured_ rather
than inferred: in the 2026-10-13 live-suite run the provider behind both `Gmail` and
`GoogleCalendar` was the single type `google` (`{"Gmail":["google"],"GoogleCalendar":["google"]}`),
named after neither toolkit. One Google connection serves them both, and **no narrower instrument
exists** — there is nothing to disconnect that ends only one of them. **Somebody disconnecting Gmail can end their Calendar**, in
production, today.

So before somebody confirms a disconnect, OpenBot names the apps that genuinely share the
connection and would end with it. _Genuinely_ is exact: siblings are computed on the **pair (vendor
identity, auth provider)**. Two _Shared_ apps that both use Google do **not** share a connection,
because each Shared app has its own randomly minted identity at Arcade — disconnecting one does not
touch the other, and the confirmation does not claim it would.

## Revoking at Arcade is not revoking at the provider

Google's consent screen is reached with `include_granted_scopes=true`, so **grants accumulate on the
account**. Somebody who consents to a read and later to a write holds both at Google, as one grant.

Disconnect deletes the Arcade connection. That ends **this deployment's** ability to act, and
OpenBot asks for the upstream withdrawal as well, but what the provider then does with the standing
grant happens out of sight. **Nobody should read Disconnect as "my Google account no longer trusts
this."** The person who wants that has to withdraw the grant at the provider itself, and an operator asked
about it should say so rather than reassure.

## The Re-check path, and what an unverified row means

Composio has a one-call probe, `askAction`, that verifies a key and which Re-check runs again.
**It is Composio's own. Arcade has no counterpart in this release.**

What an operator sees on Arcade:

- Pressing **Re-check** **refuses** rather than spending a call. It does not guess at a read to try.
- `probe_action` and `verified_at` are **not written** for an Arcade connection.
- A row therefore carries no "last checked" date.

**Nobody should read an unverified row as a broken connection.** Per-action state on Arcade is not
cached here and compared later: it is read **live from Arcade** — whether the person has authorized
an action is asked of Arcade when the page is drawn, so the answer on screen is Arcade's current
one. A connection that works and has never been "checked" is the normal state, not a fault.

## A consent coming back for the wrong person

A consent that completes but belongs to a different identity than the attempt it is returning to is
refused, and nothing is written either way. **What Arcade answers in that case carries no reason**:
_measured_ in the 2026-10-13 live-suite run, confirming a return as the wrong user answers a
generic `400`, `coordinator_error`, message `"Bad request"`, with nothing in it that names an
identity mismatch.

So the refusal a person sees is the ordinary **vendor-unavailable** one, not a sentence about the
wrong account. That is a worse message and nothing more: the attempt row is left untouched, and
the returning authorization is in any case compared to the id this deployment minted, which is the
check that actually binds the return leg to the attempt. An operator shown a vendor-unavailable
refusal on a consent that seemed to complete should consider the wrong-account case among the
causes, because the vendor will not say.

## What is unproven

The measurements above were taken by hand against a live Arcade project, when and how the top of
this page says; none is re-checked by CI, so each holds as of its date. What was never observed at
all is listed here.

- **The agentic-client checkbox was not exercised.** Google's _"Use this client for an AI-powered
  agent"_ declaration was deliberately left unticked for the measurements, so that it was not a
  variable in them. Its effect on consent, scopes or policy here is not known; see the deployer note
  above.
- **The wording of Arcade's dashboard is not described here.** This page says to set the project's
  verifier to the address above and does not name the dashboard's fields or screens, which were not
  checked against it and may change. The address itself is this deployment's.

## See also

- [Composio](composio.md) — the other broker; Personal and Shared apps, approvals and audit work the
  same way.
- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — the deployment's settings.
