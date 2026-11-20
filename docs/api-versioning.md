# API versions and compatibility

The rules for changing OpenBot's API and the apps that call it, what CI checks, and how to fix a
failure. Read this before you change the spec (`api/`), an app's requests (the web app, OpenBot
Desktop, the phone app, the Recorder), what OpenBot Desktop hands the OpenBot it starts, or a
release's `release-policy.json`.

Each rule lives in one place. This page holds the rules, what CI checks, and the checklist. The
mechanics of marking a deprecation and opening an enum are in [api/README.md](../api/README.md),
what OpenBot Desktop does with a release it can't launch is in
[desktop-updates.md](desktop-updates.md), and the security floor and the release policy are in
[releasing.md](releasing.md).

- [What these rules cover](#what-these-rules-cover)
- [The one API, and what breaking means](#the-one-api-and-what-breaking-means)
- [Deprecation](#deprecation)
- [Response enums that grow](#response-enums-that-grow)
- [The 12-month support window and minimum app versions](#the-12-month-support-window-and-minimum-app-versions)
- [launcherApi and extensionApi](#launcherapi-and-extensionapi)
- [The security floor](#the-security-floor)
- [The database under the API](#the-database-under-the-api)
- [What CI enforces](#what-ci-enforces)
- [Checklist for a pull request](#checklist-for-a-pull-request)

## What these rules cover

The compatibility rules and their tests cover two pairings:

- **OpenBot Desktop with its own OpenBot**, which the app runs on the computer and upgrades at the
  next Start after the app updates.
- **OpenBot Cloud**, one server serving every app version people have.

A company that runs its own OpenBot keeps its apps and its server matched. Nothing here is built
or tested for that pairing. Where a company's server and an app don't fit, the app says so in one
sentence (below).

## The one API, and what breaking means

OpenBot has one public API, `/api/v2`: REST in `api/openapi.yaml` and the live channels in
`api/asyncapi.yaml`. Every app uses only it. **`/api/v2` only grows.** Anything additive ships any
day. Anything breaking does not ship in place.

### Breaking

A change is breaking when a client written against the spec before it can stop working after it.
In OpenBot that is:

- Removing or renaming an operation, path, parameter, field, enum value or channel.
- Changing a field's type, format or meaning, or what `null` or a missing field means.
- Making an optional input required, or adding a new required input: a body field, a header, a
  query parameter, or a setting OpenBot Desktop must supply (see [launcherApi](#launcherapi-and-extensionapi)).
- Tightening validation: a shorter maximum length, a new pattern, a narrower enum on a request.
- Changing a default, so the same request does something different.
- Adding a value to an enum in a response, unless the spec declared that enum open from the start
  ([Response enums that grow](#response-enums-that-grow)).
- Changing the status code, the problem `code` or the problem type of an existing outcome.
- Changing paging, sorting or the shape of a cursor.
- Changing auth: a new scope needed for an existing operation, or a credential no longer taken.
- On a live channel: renaming or removing a channel or a message, removing or retyping a payload
  field, or a new required field in a message the client sends.

### Additive

- A new operation, path, channel or message.
- A new optional request field or parameter, whose default keeps today's behaviour.
- A new response field.
- Loosening validation: a longer maximum length, a wider enum on a request.
- A new error code for a new situation.
- A new value in a response enum declared open (`x-extensible-enum`).

The server ignores query parameters it doesn't know. Keep it that way
([api/README.md](../api/README.md#what-ci-checks)).

### Shipping something that would break

In order of preference:

1. **Beside the old, inside v2.** A new field, a new operation or a new request enum value, while
   the old one keeps working. Then [deprecate](#deprecation) the old one. This covers nearly every
   case.
2. **A new major, `/api/v3`, served beside v2.** Only for a change that can't be expressed beside
   the old: a different resource model, a different auth model. No `/api/v3` exists today. Opening
   one changes the lint (every path under `/api/v2/organizations/{organizationId}/`), `API_VERSIONS`
   in `shared/client-version.ts`, which `deployment` publishes as `api`, and every client.
3. **Never in place.** CI refuses a breaking change to an existing v2 operation, unless
   [api/accepted-breaking-changes.md](../api/accepted-breaking-changes.md) lists it with a reason
   showing it takes nothing from a client: the server already refused what the spec now forbids,
   or no release serves the operation yet.

The live channels follow the same rule in both directions: a server sends messages the previous
release's client can read, and accepts the messages that client sends. A message that has to
change incompatibly becomes a new message beside the old one.

### Worked examples

| Change | Allowed? | The right way |
| --- | --- | --- |
| Add `timezone` to the routine in a response | Yes | Ship it. |
| Add an optional `notes` to a request, absent meaning what it means today | Yes | Ship it. |
| Rename the request field `cron` to `schedule` | No | Add `schedule` beside `cron`, accept both, deprecate `cron` with a sunset at least 365 days out. |
| Make `description` required on `POST .../bots` | No | Keep it optional. If the server needs a value, give it a default. |
| Cut a request field's `maxLength` from 1000 to 500 | No | Keep 1000. If the server has always refused over 500, list the change with that reason. |
| Add `paused` to a response status declared `x-extensible-enum` | Yes | Ship it. Apps read it as "other" until they learn it. |
| Add `paused` to a response status declared `enum` | No | Add a new field, or declare the enum open first (see [Response enums that grow](#response-enums-that-grow)). |
| Add a value to an enum a request sends | Yes | Ship it. That loosens validation. |
| Answer an existing "not found" with 410 instead of 404 | No | Keep 404. |
| Change a problem's `code` for an existing refusal | No | Keep the code. A new situation may get a new code. |
| Remove an operation added since the last release | Yes, with a line | List it in `accepted-breaking-changes.md` with "no release serves it". CI checks that against the last release. |
| Remove a deprecated operation once its sunset has passed and nothing uses it | Yes | Delete it from the spec (see [Deprecation](#deprecation)). |
| The server starts needing a setting OpenBot Desktop must write | Only with a bump | Raise `launcherApi` (see [launcherApi](#launcherapi-and-extensionapi)). |

## Deprecation

Something a client uses is never removed in place. It is marked, announced, counted, and removed
only once nothing uses it.

- **Mark it in the spec.** `deprecated: true`, `x-deprecation-date` and `x-sunset`, both
  `YYYY-MM-DD`, on the operation, parameter or body property, with what to use instead in its
  description. How: [api/README.md, "Deprecating"](../api/README.md#deprecating).
- **The minimum notice is 365 days**, from the day it is deprecated and from the first release that
  served it deprecated, for every kind of element, app-only ones included.
- **Answered with headers, never by hand.** Every request that uses a deprecated operation,
  parameter or body property is answered with `Deprecation`
  ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745.html), `@<unix seconds>`), `Sunset`
  ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594.html), an HTTP-date) and
  `Link: <changelog>; rel="deprecation"`, refusals included. The server reads the marks from the
  spec it is generated from.
- **Counted per app.** Each use is counted by the app that made it, from the `OpenBot-Client`
  header: each OpenBot app and release the header names, `unknown` with no header, `other` for a
  header that names no OpenBot app. The count that decides removal is OpenBot Cloud's.
- **Announced in the changelog.** One line in the Deprecated list under `## Unreleased`'s "Before
  upgrading" in [CHANGELOG.md](../CHANGELOG.md), naming it as the server counts it, with its
  replacement and its sunset.
- **Removed when both are true:** its sunset has passed, and nothing has used it over the last 12
  months by that count. Otherwise it stays, and its sunset moves later, never earlier. A response
  property is the one exception: it gets no header and no count, and its sunset alone decides.

Live channels have no deprecation marks or counts. A channel or message is replaced by a new one
beside it, and removing the old one is a breaking change like any other.

## Response enums that grow

CI fails a value added to a response enum. An enum whose list is expected to grow (a status, a role, a kind) is declared open instead:
`x-extensible-enum` in place of `enum`, with today's values. CI then lets a value be added. How,
and which enums may be open: [api/README.md, "Enums that grow"](../api/README.md#enums-that-grow).

**Every OpenBot app is a tolerant reader:**

- It ignores a response field it doesn't know.
- It reads an enum value it doesn't know as "other": never a crash, never "undefined", never a
  guess at a known value. An unknown role is a member, never an admin.
- It never sends back a value it doesn't know. An enum a client sends, or sends back as it read
  it, stays closed (`enum`), and a response gets its own open copy where it needs one.

Write any new screen the same way: a `switch` or a lookup on a status needs a branch for a value
the app has never seen. The tests below fail a generated client or a screen that doesn't.

## The 12-month support window and minimum app versions

**A server serves every app released in the last 12 months, and an app works against any server
released in the last 12 months**, hiding what the server doesn't offer. The window is time, not a
count of releases, and it starts no earlier than each app's first release on `/api/v2`: 1.1.0 for
all four apps (`FIRST_ONE_API_RELEASES`
in `shared/client-version.ts`).

### How an app and a server find out

- **Every app names itself on every request:** `OpenBot-Client: <kind>/<version>`, kind `web`,
  `desktop`, `mobile` or `recorder`. A header may name several, separated by spaces: OpenBot
  Desktop adds its own after its window page's (`web/1.1.0 desktop/1.1.0`). A program of your own
  sends nothing, or its own name, and is never refused for a version.
- **Every server publishes what it serves** on `GET /api/v2/organizations/{organizationId}/deployment`,
  which answers before sign-in and is never refused for an app's version: `api` (the majors served,
  `["v2"]`), `minimumClients` (the oldest release of each app it serves), `securityMinimumClients`
  (the part of those raised for a security problem, only when there is one), `launcherApi` and
  `extensionApi`. It never publishes the build's own version.
- **An app below its minimum is refused** on every other `/api/v2` operation with 400,
  `application/problem+json`, code `CLIENT_UPDATE_REQUIRED`, naming `client` and `minimumVersion`,
  with `security: true` when the minimum is there for a security problem, and a sentence in
  `detail`. Never 426.
- **A feature the server lacks is hidden** by the `deployment` field that offers it, never by
  comparing versions.

`shared/client-version.ts` holds these rules and `shared/fixtures/client-version/cases.json` holds
the cases. The web app and the Recorder read the module; OpenBot Desktop (Rust) and the phone app
carry their own copy, and their tests run every case.

### Where minimums come from

- **Built in, per release:** `MINIMUM_CLIENTS` in `shared/client-version.ts`. A release may name an
  app's minimum only at a release published more than 12 months before it. Every OpenBot release is
  younger than that, so it is empty, and nothing released is refused by it.
- **Per server:** `OPENBOT_MINIMUM_CLIENTS` on the server, `<app>=<release>,...`, for example
  `desktop=1.2.0,mobile=1.2.0`. It raises a minimum for that server and never lowers one. This is
  how OpenBot Cloud raises its own. A server leaves it unset unless its admin chooses otherwise.
- **The security floor**, on OpenBot Cloud only (below).

Each app's minimum is the highest of the three. Nothing lowers a minimum.

### What each app shows

| App | Too old for the server | Below a security minimum |
| --- | --- | --- |
| Web app | "Update OpenBot", "This page is from an older version of OpenBot.", with **Update**, which loads the new page. A tab left open across an upgrade gets it on its next request. Inside the OpenBot Desktop window, when the refusal names Desktop, **Update and restart**. | "This version of OpenBot has a security problem. Update to keep using it." |
| OpenBot Desktop, its own OpenBot | "Update OpenBot" with **Update and restart**, before the window opens. | The same security sentence. |
| OpenBot Desktop, connected | "The OpenBot at {host} needs a newer version of this app. Update OpenBot, then connect again.", with **Update and restart**, when the person connects and on every launch. | The same security sentence. |
| Phone app | "Update OpenBot" with the server's sentence and **Try again**. | The same security sentence. |
| Recorder | The server's sentence on the popup, the Connect page and Connect with OpenBot Desktop. | The same security sentence. |

When the server is older than the app can use (it serves only older API majors), the web app says
"Ask whoever runs your OpenBot to update it", and OpenBot Desktop's connected mode says "The
OpenBot at {host} is on a release this app can't connect to yet. Ask whoever runs it to update
OpenBot, or open it in your browser."

## launcherApi and extensionApi

`release-policy.json` carries three contract numbers under `compatibility`, and every release
publishes them in its `release-manifest.json`. Two of them are about apps:

- **`launcherApi`**: what OpenBot Desktop writes into `.env` and hands Compose when it starts an
  OpenBot on the computer (`desktop/src-tauri/src/env.rs`, `docker-compose.yml`): the launcher
  inputs.
- **`extensionApi`**: what the Recorder and OpenBot exchange.

### What a launcherApi bump means

An app is built with its release's `launcherApi`. Against a release whose number is higher:

- **A first install** lays out the app's own release instead of the latest, and the update bar
  offers the newer app. An unreadable manifest also lays out the app's own release.
- **Start** doesn't start it and doesn't move the installation back. The window says "Update
  OpenBot", "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep
  going.", with **Update and restart**.
- A release one number behind starts as before.

Details: [desktop-updates.md](desktop-updates.md#the-upgrade).

`launcherApi`, `configSchema` and `extensionApi` must also match exactly for the release tooling
to upgrade an installation (`planUpgrade` in `shared/release-manifest.ts`). Raise one only in a
release pull request, in the policy it writes.

### When you must raise launcherApi

**When the OpenBot server needs a launcher input that an app of the current number doesn't
supply:** a new required setting, or an optional one made required. A server that starts as before
without the new setting doesn't need a bump.

### How an older OpenBot Desktop gets the update page

When OpenBot Desktop started the server and a launcher input is missing, the server doesn't exit.
It answers `/health` and `/api/capabilities`, and serves one page at `/`: "Update OpenBot. This
OpenBot needs a newer version of the OpenBot app. Update the app, then open it again." Everything
else is refused with the same sentence. A server started any other way is refused at start, naming
the setting.

### extensionApi

The Recorder's calls are `/api/v2` operations and a live channel, and the API rules on this page
cover them. `deployment` publishes `extensionApi` and the release tooling compares it; no Recorder
reads it yet.

## The security floor

A forced update, for a release with a security problem and for nothing else. The floor names the
lowest safe release of OpenBot Desktop, the OpenBot Desktop runs on the computer, the phone app and
the Recorder. Below it an app shows one notice, "This version of OpenBot has a security problem.
Update to keep using it.", and nothing else until it is updated.

- **Signed.** `security-floor.json` beside `latest.json` on the Latest release, with its own
  Ed25519 signature over the payload's exact bytes. Every app verifies it against keys it was
  built with (`shared/security-floor.json`) before it reads anything in it.
- **Who signs it.** The Security floor workflow, run by hand on `main` after the fixed release is
  Latest. A required reviewer of the `security-floor` environment approves the signing job, the
  only place the key can be read.
- **How apps enforce it.** At launch and every six hours. Each app keeps the floor with the highest
  serial it has verified and ignores a lower one. Offline, the kept floor
  holds; a first launch that never reached it runs. OpenBot Desktop also stops the OpenBot it runs
  on the computer (no Bot runs, routines pause, nothing is deleted), and the Recorder stops
  recording.
- **Where it doesn't apply.** Never for a company's own OpenBot. Desktop's own OpenBot always
  follows the floor; any other OpenBot only when the floor lists its address under `cloud`, which
  names OpenBot Cloud's addresses and nothing else. On OpenBot Cloud the floor also raises the
  server's minimums: an app below it is refused with `CLIENT_UPDATE_REQUIRED` and `security: true`.

A floor overrides the 12-month window. How to raise one, and the one-time setup: [releasing.md, "Security floor"](releasing.md#security-floor).

## The database under the API

A release's database changes must leave a database the previous release's server still works
against. `upgrade.requiresDowntime` in `release-policy.json` is `false` for such a release, which is
the rule. A release that can't keep to it declares `true`, and the `openbot` chart it ships must
declare the same, which stops every old server before a new one starts. Publishing refuses a policy
and a chart that disagree ([releasing.md](releasing.md#release-candidates-and-betas)).

When a database change does remove something the API returns, the API change comes first and goes
through [Deprecation](#deprecation); the database keeps both shapes until the old API surface is
gone.

## What CI enforces

### The `API spec` job (`.github/workflows/ci.yml`)

| Step | Fails when | Fix it the right way | Not like this |
| --- | --- | --- | --- |
| The bundled spec matches its sources; the generated clients match the spec | `api/openapi.yaml` or a generated client isn't what the sources make | `bun run api:generate` and commit the result | Editing `api/openapi.yaml` or a generated file by hand |
| Lint the spec | A path outside `/api/v2/organizations/{organizationId}/`, an error that isn't `application/problem+json`, a write without `Idempotency-Key`, a list without `cursor` and `limit`, and the other conventions in `redocly.yaml` | Follow the convention | Adding an exception to the rules |
| No breaking change against the base branch | oasdiff (pinned by version and checksum, one release behind its newest) reports a breaking change, warnings included, that `api/accepted-breaking-changes.md` doesn't list; or a deprecation breaks the 365-day window: `api-deprecated-sunset-missing`, `api-sunset-date-too-small`, `api-sunset-date-changed-earlier`, `api-removed-before-sunset` | Ship the change beside the old one; give a deprecation an `x-sunset` 365 or more days out; put back what was removed early | Listing a change that does take something from a client; moving a sunset earlier |
| No breaking change against the last release | The same comparison against the newest published release at or below this tree's version. Lines saying "no release serves it" are not applied, so a change let through on that reason fails if the release does serve it | Fix the change; or, if the reason was wrong, take the line out and ship beside the old | Rewording the line to avoid "no release serves it" |
| The 12-month support window holds (`scripts/support-window.ts`) | A minimum in `MINIMUM_CLIENTS` would turn away an app published in the last 12 months on the one API; or a deprecation has no valid `x-sunset`, or one less than 365 days after the release that first served it deprecated | Lower the minimum to the oldest release in the window (the message names it); move the sunset to the date the message gives | Moving `FIRST_ONE_API_RELEASES` later to make a minimum fit |
| No breaking change to the live channels against the base branch (`api/asyncapi-diff.ts`) | Anything in `api/asyncapi.yaml` that isn't new things, a new optional member or wording, and isn't listed in `api/accepted-live-breaking-changes.md` | A new message or member beside the old one | Listing a change a client would notice |

The live channels are compared with the base branch only.

### Tests that hold the rules

| Test | Fails when |
| --- | --- |
| `shared/tests/api-deprecations.test.ts` | A deprecation mark is incomplete (a date missing or invalid, a sunset before the deprecation, a path parameter marked on its own), or `CHANGELOG.md` doesn't list a deprecation with its sunset. |
| `api/openapi-extensible-enums.test.ts` | A parameter or request body reaches an open enum, or an open enum also has `enum`. |
| `app/tests/tolerant-reader.test.ts`, `mobile/tests/tolerant-reader.test.ts` | A generated client throws on an unknown field or enum value. |
| `app/tests/unknown-enum-values.test.tsx`, `mobile/tests/unknown-statuses.test.ts` | A screen crashes, says "undefined" or guesses a known value for a status, role or kind it doesn't know. |
| `shared/tests/client-version.test.ts`, and Desktop's, the phone app's and the Recorder's client-version tests | An app decides differently from a case in `shared/fixtures/client-version/cases.json`, or drops its `OpenBot-Client` header. |
| `desktop/src-tauri/src/deployment_release.rs` tests | OpenBot Desktop lays out or starts a release whose `launcherApi` is above its own. |
| `tests/release-policy.test.ts` | `release-manifest.ts --validate-policy` accepts a policy whose `requiresDowntime` disagrees with the chart. |

Fix the code, not the test. A failing case in `cases.json` is a rule every app keeps.

### Desktop upgrade (`.github/workflows/desktop-upgrade.yml`)

Runs OpenBot Desktop's own upgrade code (stop, back the database up, set the previous version
aside, lay out, pull, start, put everything back on failure) from real published releases to this
tree. On a pull request that touches the app, `docker-compose.yml`, `backend-images.env` or
`release-policy.json`, it upgrades from the previous release. Nightly and on demand, from every
release of the last 12 months an installation can still be on (`desktop/scripts/upgrade-legs.ts`).

**Fails when** the upgrade doesn't move, what the old release wrote doesn't read back from the new
one, or a migration ran twice. **Fix it** in what changed: usually a Compose or launcher change the
old release's layout can't carry, or an image this tree pins that doesn't start on the old data.
Never by dropping a release from the legs.

## Checklist for a pull request

**I'm changing the API spec.**

- [ ] The change is additive, or it ships beside the old one. Nothing is removed or tightened in
      place.
- [ ] A new response enum that will grow is `x-extensible-enum`; a request enum stays `enum`.
- [ ] Anything replaced is deprecated with `x-deprecation-date` and an `x-sunset` at least 365 days
      out, says what to use instead, and is in the changelog's Deprecated list.
- [ ] A line in `accepted-breaking-changes.md` only for a change that takes nothing from a client,
      with the reason; "no release serves it" only when that is true.
- [ ] `bun run api:generate` run, and the sources, the bundle and the generated clients committed
      together.

**I'm changing an app's requests or screens.**

- [ ] Every request goes out with the app's `OpenBot-Client` header (through the app's one client).
- [ ] A new feature is shown only when `deployment` (or the answer) offers it, never because of a
      version.
- [ ] A status, role or kind the app doesn't know reads as "other", and is never sent back.
- [ ] A new response field is optional to the app: the screen works without it, against an older
      server.

**I'm changing what OpenBot Desktop hands the OpenBot it starts.**

- [ ] If the server now needs an input apps of the current `launcherApi` don't supply, the release
      that ships it raises `launcherApi`.
- [ ] The previous release still lays out and starts (the Desktop upgrade job).

**I'm writing a release's `release-policy.json`.**

- [ ] `requiresDowntime` is `false` unless the release truly can't keep the previous release
      working on its database, and the chart's annotation says the same.
- [ ] A contract number is raised only for a change that needs it: the release tooling won't
      upgrade an installation across a change in one.
- [ ] `MINIMUM_CLIENTS` names no release published in the last 12 months.
