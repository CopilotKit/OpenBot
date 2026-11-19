# OpenBot's API spec

`api/openapi.yaml` is the REST API every client is generated from and every check reads: the app's
client (Orval), the breaking-change check (oasdiff), the lint (`bun run api:lint`) and the server's
contract tests. It is a bundle. Never edit it by hand: edit its sources and bundle.

## Sources

The sources live in `api/openapi/`, one file per area, so builders working on different areas do
not touch the same lines:

| File | What it holds |
| --- | --- |
| `common.yaml` | The root: info, servers, tags, security schemes and OAuth scopes, the list of paths, and what every area shares (problem details, paging, Idempotency-Key, shared headers and responses) |
| `bots.yaml` | Bots |
| `audit-events.yaml` | The audit trail |
| `accounts.yaml` | People, API keys, sessions, linked accounts and identity providers |
| `admin-settings.yaml` | Deployment, organization settings, capabilities, network policies, model usage, computer actions and the setup checklist |
| `conversations.yaml` | Conversations and their members, messages and attachments, tasks, reactions, dictation, voice calls, conversation join tokens and product events |
| `model-connections.yaml` | The vault, the model key, the model catalogue and model choices |
| `notifications.yaml` | Devices, destinations, deliveries and notification settings |
| `components.yaml` | The components a Bot draws, their drafts and publishing, their data functions, and which a Bot may use |
| `skills.yaml` | Skills |
| `apps.yaml` | The apps added to OpenBot, the app directory, app setup and each app's account mode and OAuth client |
| `connections.yaml` | A person's connections to apps and their accounts, and an app's shared connection |
| `bot-grants.yaml` | What a Bot was given: its grants and apps, giving and taking back an app, and app access requests |
| `schedules.yaml` | Routines, check-ins and what they found, goals with their triggers and GitHub event sources, and a Bot's follow-ups |
| `approvals.yaml` | Approvals and questions, approval rules and settings, reviewer guidance, boundaries, what-if, shared app accounts and folder access |
| `organizations.yaml` | The organizations a person is a member of, and each one's members |
| `computers.yaml` | A Bot's computer: its state, screen, control, a Bot's actions on it, its files, and the administrator's list |
| `browsers.yaml` | A Bot's browser and a person's own OpenBot browser |
| `passwords-and-recorder.yaml` | Sign-in requests, saved logins and the Recorder |
| `learning.yaml` | OpenBot's side of Automatic learning: Learning settings, each person's spaces and sharing choices, sharing requests, and the skills delivered to Bots |
| `memory.yaml` | A person's memories and memory sources |
| `agents.yaml` | The agents Bots hand work to (`bot-agents`), their callback tokens, and each Bot's delegation |

An area file holds its operations under `paths`, and under `components` the schemas, parameters,
responses and examples only it uses. Inside the file, refer to them as usual
(`'#/components/schemas/Bot'`); refer to a shared one in `common.yaml`
(`'./common.yaml#/components/responses/Unauthenticated'`). The bundle names every component after
its own key, so pick a name no other area uses; a clash fails the bundle.

`common.yaml` lists each path once, as a `$ref` into its area file. A new component needs no line
there; the ones listed as `$ref`s into area files are listed only to keep the bundle's order. Keep
each tag, scope and path in `common.yaml` on one line, so a merge keeps every entry whole.

## The builder rule

1. Edit the area file (and, for a new path, tag or scope, append one line to `common.yaml`).
2. Run `bun run api:generate`. It bundles `api/openapi.yaml` first, then regenerates the client.
3. Commit the sources, `api/openapi.yaml` and `app/src/lib/api/generated` together.

After a rebase, run `bun run api:bundle` and `bun run api:generate` again and commit what changed.
`common.yaml`, `api/openapi.yaml` and the generated client's index files merge with git's union
driver (`.gitattributes`), which keeps both sides' appended lines instead of stopping on a
conflict; the bundle and the client are rebuilt from the merged sources, and CI's drift checks
(the bundle matches its sources, the client matches the bundle) catch anything the merge got
wrong. If both sides changed the same line of `common.yaml`, union keeps both: delete the stale
one.

## What CI checks

The `API spec` job in `.github/workflows/ci.yml` fails a pull request when:

- `api/openapi.yaml` is not what its sources bundle to, or `app/src/lib/api/generated` is not what
  it generates;
- `bun run api:lint` fails. It runs Redocly's strict rules and OpenBot's conventions
  (`redocly.yaml`, `api/redocly/rules.mjs`): OpenAPI 3.1, every path under
  `/api/v2/organizations/{organizationId}/`, no path CopilotKit Intelligence already serves
  (`api/intelligence-reserved.yaml`), errors as `application/problem+json`, an `Idempotency-Key` on
  every write, and `cursor` and `limit` on every list;
- the spec breaks a client of the base branch's spec (oasdiff). A change that takes nothing from a
  client goes through only when it is listed with its reason in
  [accepted-breaking-changes.md](accepted-breaking-changes.md);
- the spec breaks a client of any release whose apps the server still serves: each release of the
  last 12 months and the last release, each against its own spec (oasdiff again), a deprecation names no
  `x-sunset` at least 365 days out, or a minimum app version cuts the 12-month support window
  (`scripts/support-window.ts`).

What makes each of these fail, and how to fix it the right way:
[docs/api-versioning.md](../docs/api-versioning.md#what-ci-enforces).

The server ignores query parameters it does not know rather than refusing them, on purpose: a
tolerant reader, so a client written against a newer spec still works against an older server.

## Deprecating

Something a client uses is never removed in place. It is marked deprecated in the spec, answers
with the standard headers from then on, and is removed only when two things are both true: its
sunset has passed, at least 12 months after it was deprecated, and nothing has used it over the
last 12 months, by the count OpenBot Cloud keeps of every use. A property of a response is the one
exception: nothing can count it, so its sunset alone decides (below).

1. Mark it in its area file: `deprecated: true` on the operation, the query or header parameter, or
   the property of a request or response body, with `x-deprecation-date` (the day it is deprecated)
   and `x-sunset` (the earliest day it may go, the extension oasdiff reads), both `YYYY-MM-DD`. Say
   in its description what to use instead.

   ```yaml
   cron:
     type: string
     deprecated: true
     x-deprecation-date: 2026-12-01
     x-sunset: 2027-12-01
     description: Deprecated. Send `schedule` instead.
   ```

2. List it in [CHANGELOG.md](../CHANGELOG.md), in the Deprecated list under `## Unreleased`'s
   "Before upgrading": one line naming it as the server counts it, in backticks, with what replaces
   it and its sunset. An operation is its method and path; a part of one adds `query <name>`,
   `header <name>`, `body <property>` or `response <property>`, with `[]` for an array's items.

   ```markdown
   - **Deprecated.** Each still works, answers with `Deprecation` and `Sunset` headers, and is
     removed no earlier than its sunset, and only once nothing uses it.
     - `PATCH /api/v2/organizations/{organizationId}/routines/{routineId} body cron`: send
       `schedule` instead. Sunset 2027-12-01.
   ```

`shared/tests/api-deprecations.test.ts` fails a pull request whose marks are incomplete or whose
deprecations the changelog doesn't list. The server reads the same marks from the spec it is
generated from, so a request that uses a deprecated element is answered with `Deprecation`
([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745.html)), `Sunset`
([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594.html)) and `Link: <changelog>; rel="deprecation"`,
and each use is counted by the app that made it, from its `OpenBot-Client` header. Nobody writes
those headers by hand. A deprecated response property is listed and dated the same way, but no
answer is marked for it and nothing counts it: a server can't see which fields a client reads. So a
response property's removal waits on the 12-month window alone: it may go once its sunset has
passed.

To remove it, once both conditions hold, delete it from its area file and regenerate. oasdiff
doesn't report a removal on or after its `x-sunset`, and fails one before it
(`api-removed-before-sunset`). The policy behind these rules, and what each CI failure means, is in
[docs/api-versioning.md](../docs/api-versioning.md).

## Enums that grow

A value added to an enum a client reads in a response breaks a client that only knows the old
values, so oasdiff fails it. An enum whose list is expected to grow (a status, a role, a kind of
scope) is declared open instead: `x-extensible-enum` in place of `enum`, with the values it has
today ([Zalando rule 112](https://opensource.zalando.com/restful-api-guidelines/#112)). oasdiff
then lets a value be added, and the generated clients read it as a string.

```yaml
status:
  type: string
  x-extensible-enum: [queued, running, succeeded, failed]
```

Every OpenBot client is a tolerant reader: it ignores a response field it doesn't know, and reads an
enum value it doesn't know as "other" instead of failing. `app/tests/tolerant-reader.test.ts` and
`mobile/tests/tolerant-reader.test.ts` hand the generated clients both and check nothing throws.

Only an enum no request carries can be open, because the server checks what a request sends
against the list. An enum a client also sends, or sends back as it read it (a shared account's
audience, which is read and then saved again, or the permission switch changes a model wrote, which
are previewed and then saved), stays `enum`; a response gets its own open copy
where it needs one, as `PersonRoleAnswer` is for `PersonRole`. `api/openapi-extensible-enums.test.ts`
fails a request that reaches an open enum.

## The live channels

`api/asyncapi.yaml` (AsyncAPI 3.1) describes every WebSocket: a Bot's run as it streams, what
changed in a person's conversations, a Bot's screen and terminal, a voice call, and what the
Recorder captures. It is one file, edited by hand, and `bun run api:lint` lints it with the REST
spec. CI compares it with the base branch's (`bun run api:live:diff <base file> api/asyncapi.yaml`;
`api/asyncapi-diff.ts` says what counts as breaking), and
[accepted-live-breaking-changes.md](accepted-live-breaking-changes.md) lists the changes let
through.

## Adding an area

1. Create `api/openapi/<area>.yaml` with a `paths:` map (and a `components:` map if it has its own
   components), in the same shape as the other area files.
2. Point `common.yaml` at each of its paths, escaping `/` as `~1` in the pointer:
   `/api/v2/organizations/{organizationId}/things: { $ref: './things.yaml#/paths/~1api~1v2~1organizations~1{organizationId}~1things' }`
3. Add its tag and OAuth scopes to `common.yaml`, then run `bun run api:generate`.
