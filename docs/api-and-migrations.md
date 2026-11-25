# Don't break the API. Don't break the database.

OpenBot is live. People run released apps (the web app, OpenBot Desktop, OpenBot Mobile, the
Recorder) against released servers, and they don't all upgrade on the same day. Every change has to
keep working for them.

**Read this before you change anything under `api/`, an app's requests, the server's database, or
`release-policy.json`. This applies to every contributor and every coding agent, every time. It is
not optional.**

This page is the rules. The detail behind them is in [api-versioning.md](api-versioning.md) and
[api/README.md](../api/README.md). Where they say more, they win.

## Who you must not break

- **A server serves every app released in the last 12 months.** An app works against any server
  released in the last 12 months. The window is time, not a count of releases.
- **OpenBot Desktop upgrades its own server at the next Start,** so the app is often newer than the
  server it runs.
- **OpenBot Cloud runs one server for every app version people have.** During a rolling upgrade,
  the old release's servers and the new one's share one database.
- **A failed upgrade puts the previous server back** on a database the new one may have partly
  migrated.

## The API: anything a released app uses keeps working for 12 months

1. **`/api/v2` only grows.** Add things. Never remove, rename or change in place.
2. **Never remove or rename** an operation, path, parameter, field, enum value, channel or message
   that a released app uses.
3. **Never change what an existing thing means:** a field's type or format, what `null` or a missing
   field means, a default, the status code, problem `code` or problem type of an existing outcome,
   paging, sorting, the shape of a cursor, or the scope an operation needs.
4. **New request inputs are optional,** and leaving one out does what happens today. Never make an
   optional input required. Never tighten validation on a request (a shorter maximum, a new
   pattern, a narrower enum).
5. **Response enums that will grow are open from the start:** `x-extensible-enum`, not `enum`. Only
   an open enum may gain a value. An enum a client sends, or sends back as it read it, stays
   `enum`; the answer gets its own open copy (`PersonRoleAnswer` for `PersonRole`).
6. **Replace beside the old, then deprecate the old.** Mark it `deprecated: true` with
   `x-deprecation-date` and `x-sunset` (both `YYYY-MM-DD`), the sunset at least 365 days out. Say
   in its description what to use instead. List it in `CHANGELOG.md`'s Deprecated list. How:
   [api/README.md, "Deprecating"](../api/README.md#deprecating).

   ```yaml
   cron:
     type: string
     deprecated: true
     x-deprecation-date: 2026-12-01
     x-sunset: 2027-12-01
     description: Deprecated. Send `schedule` instead.
   ```

7. **Remove it only when both are true:** its sunset has passed, and nothing has used it for the last
   12 months. A response property can't be counted, so its sunset alone decides. A sunset only ever
   moves later.
8. **A change that can't go beside the old needs a new major,** `/api/v3`, served beside v2. None
   exists today.
9. **Every app is a tolerant reader.** It ignores a field it doesn't know. It reads an enum value it
   doesn't know as "other", and never sends one back. It shows a feature only when the server's
   `deployment` answer offers it, never by comparing versions.
10. **Edit the area files under `api/openapi/`, never the bundle.** Run `bun run api:generate` and
    commit the sources, `api/openapi.yaml` and the generated clients together.

### Breaking or not

| Change | Allowed? |
| --- | --- |
| A new operation, or a new field in an answer | Yes |
| A new optional request field whose absence keeps today's behaviour | Yes |
| A new value in a request enum, or a longer maximum length | Yes |
| A new value in a response enum declared `x-extensible-enum` | Yes |
| A new value in a response enum declared `enum` | No. Add a new field, or open the enum first. |
| Rename `cron` to `schedule` | No. Add `schedule`, accept both, deprecate `cron`. |
| Make an optional field required | No. Keep it optional; give the server a default. |
| Answer an existing "not found" with 410 instead of 404 | No |
| Change a refusal's problem `code` | No. A new situation may get a new code. |
| Remove a deprecated operation after its sunset, unused for 12 months | Yes |

More cases: [api-versioning.md, "Worked examples"](api-versioning.md#worked-examples).

### Check before you push

```sh
bun run api:generate     # then git status: nothing may change
bun run api:lint
git show origin/main:api/openapi.yaml > /tmp/base-openapi.yaml
oasdiff breaking /tmp/base-openapi.yaml api/openapi.yaml --flatten-allof \
  --deprecation-days-stable 365 --deprecation-days-beta 365 --fail-on WARN \
  --err-ignore api/accepted-breaking-changes.md --warn-ignore api/accepted-breaking-changes.md
git show origin/main:api/asyncapi.yaml > /tmp/base-asyncapi.yaml
bun run api:live:diff /tmp/base-asyncapi.yaml api/asyncapi.yaml
```

CI's `API spec` job runs all of these, and also holds the spec to every release of the last 12
months and to the 12-month window (`scripts/support-window.ts`). What each failure means, and the
right fix: [api-versioning.md, "What CI enforces"](api-versioning.md#what-ci-enforces).

**Never make CI pass by listing a change in `api/accepted-breaking-changes.md` that takes something
from a client.** A line there is only for a change no client can notice: the server already refused
what the spec now forbids, or no release serves the operation yet.

## The database: a migration never breaks a running server

1. **The previous release keeps working.** Every database change in a release leaves a database the
   previous release's server still works against.
2. **Expand in any release:** a new table, a new nullable column or one with a constant default, an
   index built concurrently, a new enum value.
3. **Contract only in a later release:** dropping or renaming a table or column, changing a type,
   making a column `NOT NULL`, dropping an enum value. Only for what a release that is already out
   stopped reading and writing, and the migration names that release.
4. **Backfill so no write is lost.** A backfill is safe to run twice. It runs in the release that
   expands, and again in the release that contracts, before the drop.
5. **The API comes first.** If a database change removes something the API returns, the API change
   ships beside the old one and goes through deprecation. The database keeps both shapes until the
   old API is gone. The contract comes after that, never before.
6. **No long locks.** Set a lock timeout and a statement timeout. Build an index on a table that has
   rows `CONCURRENTLY`. Add a constraint `NOT VALID`, then validate it.
7. **Forward only, backup first.** No down migrations. Every upgrade that changes the database takes
   a backup first, and recovery is restoring it (`"recovery": "restore-backup"`).
8. **A merged migration is never edited, renumbered or deleted.** A database that ran it refuses to
   migrate once it changes. Fix forward with a new migration.
9. **Downtime is the rare, declared exception.** A release that truly can't keep rule 1 says
   `"requiresDowntime": true` in `release-policy.json`, and the chart it ships says the same.
   Publishing refuses the two disagreeing.

### `release-policy.json`

Each release's `release-policy.json` says which releases and databases it upgrades from.

- **`compatibility.database.to`** is the last migration this release's server applies.
- **`compatibility.database.from`** is the last migration of each starting release.
- **`upgrade.fromVersions`** lists the starting releases: every release an installation may be on
  when it takes this one, release candidates people installed included.

Publishing checks `to` and `from` against the migrations themselves, and a refusal names the value
to write. When a candidate is installed, its version joins `fromVersions` and its last migration
joins `database.from` (1.2.0 added `v1.2.0-rc.1` and `0161_ai_connection_shared_sign_in`).

### What a managed upgrade refuses

The management agent upgrades only along the policy (`planUpgrade` in `shared/release-manifest.ts`).
It refuses:

- a starting release not in `upgrade.fromVersions`;
- a starting database not in `compatibility.database.from`;
- a `launcherApi`, `configSchema` or `extensionApi` that differs from the installation's;
- a capability the release needs that the installation lacks.

Before an upgrade that changes the database, it confirms where the backup goes and takes the
backup. If it can't confirm that, it changes nothing. It never rolls a database back by itself: a
`restore-backup` recovery needs a person.

### The test that proves it

The `Desktop upgrade` workflow runs OpenBot Desktop's own upgrade from real published releases,
with the data they wrote, to your tree: on a pull request from the previous release, and nightly
from every release of the last 12 months. It fails when what the old release wrote doesn't read back
or a migration runs twice. Fix the change, never the list of releases.

## Checklist for every pull request that touches the API or the database

- [ ] I read this page.
- [ ] Nothing a released app uses is removed, renamed, retyped or tightened in place.
- [ ] New request inputs are optional; a response enum that will grow is `x-extensible-enum`.
- [ ] Anything replaced is deprecated with an `x-sunset` at least 365 days out, and listed in the
      changelog.
- [ ] Nothing new in `api/accepted-breaking-changes.md` takes anything from a client.
- [ ] `bun run api:generate` run, and sources, bundle and clients committed together.
- [ ] Every database change is an expand, or a contract of what a release already out stopped
      using. No merged migration is edited, renumbered or deleted.
- [ ] `release-policy.json` names the right `database.to`, `database.from` and `fromVersions`.
- [ ] CI's `API spec` job is green on the exact head.
