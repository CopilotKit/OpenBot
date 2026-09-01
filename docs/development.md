# Development

## Setup

Install Docker, [Bun](https://bun.sh) 1.3+, `lsof`, `python3`, and `curl`. Local Codex mode also needs
the Codex CLI authenticated with `codex login`.

```sh
cp .env.example .env
bun install
```

Provision CopilotKit Intelligence after `.env` exists:

```sh
npx --yes copilotkit@latest login
npx --yes copilotkit@latest project select
npx --yes copilotkit@latest license --write
```

Put the `cpk-...` runtime key from `project select` in `.env` as
`INTELLIGENCE_API_KEY`. `license --write` writes `COPILOTKIT_LICENSE_TOKEN`.
Then add `OPENAI_API_KEY`. To use the local ChatGPT account instead, set
`CODEX_AGENT_ENABLED=true` and `AGENT_ENDPOINT_ALLOWED_HOSTS=localhost:4202`; see
[the Codex coworker guide](../agent-codex/README.md).

Start the stack:

```sh
bash scripts/start.sh
```

## Running services

Use `bash scripts/start.sh` for the full local stack. It starts Docker services, applies migrations, starts the API server and app, and verifies health routes.

Use `bun run dev` only when you want the app and API server without starting the Docker Bots and computers.

| Service           | Port                       |
| ----------------- | -------------------------- |
| `app`             | 3010                       |
| `server`          | 3001                       |
| `agent-computer`  | 4100                       |
| `agent-bot`       | 4200                       |
| `agent-langgraph` | 4201                       |
| `agent-codex`     | 4202 (only in local Codex mode) |
| `supervisor`      | 4500 host / 4300 container |
| PostgreSQL        | 5432                       |

`start.sh` leaves existing matching services alone and reports when a port is held by another process.
With `CODEX_AGENT_ENABLED=true`, it runs `agent-codex` on the host and skips the `agent-bot` and
`agent-langgraph` containers.

## Migrations

After changing the Drizzle schema:

```sh
bun run --filter server db:generate
bun run --filter server db:migrate
```

Review generated migration files before sharing them. `start.sh` applies existing migrations when it starts the stack.

**Do not hand-edit a generated migration.** It leaves a file that no longer matches what the
generator produced. If the generated SQL will not work — `ADD COLUMN ... NOT NULL` fails on a table
that already has rows — split it instead: generate the column nullable, add the data step, then
generate the constraint.

**A constraint that tightens an existing column belongs to a later release**, not to the release that
adds the column. A rolling deploy runs the migrations and then serves from old and new replicas at
once, and an old replica writes rows without the new column: under `NOT NULL` its writes start
failing, so the release that added the column breaks for everybody who lands on a replica that has
not been replaced yet. Ship the column nullable, let the fleet turn over, then tighten it. `issuer`
on `accounts` is the worked example: the column is nullable and no migration tightens it.

**A data step is its own migration**, created with the flag that exists for it:

```sh
bun run --filter server db:generate -- --custom --name=backfill_something
```

A generator diffs schema against schema, so a rule like "the rows whose provider is Google get
Google's issuer" can never come out of one: it is not in the schema. `--custom` writes an empty file
registered in the journal, and it is the only migration anybody should be writing by hand.

CI enforces two things about this: `drizzle-kit check` for collisions and gaps between migrations,
and a generate-and-fail-if-dirty probe that refuses a schema change with no migration written for it.

**If `drizzle-kit migrate` hangs and then exits non-zero with no error**, the journal names a
migration file that is not there. A rebase does this: `meta/_journal.json` is a checked-in file, so
restoring it can reinstate entries for migrations that were renamed. `drizzle-kit check` reports
"Everything's fine" in that state, because it compares schemas rather than checking that the journal
and the directory agree. Compare `meta/_journal.json` against `ls server/drizzle/*.sql`.

## Quality checks

Run these before opening a pull request:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Integration tests expect a PostgreSQL database with pgvector. Use `start.sh` or point `DATABASE_URL` at a compatible database.

They write to whichever database `DATABASE_URL` names and leave their rows behind, so running
them against a deployment you are using puts test Bots in its audit trail and its activity
reports. Point `DATABASE_URL` at a database of their own to keep the two apart.

CI uses `bun run test:ci` to verify the expected test count in addition to normal tests.

`bun run test:smoke` is separate and needs a deployment that is up:

```sh
bash scripts/start.sh
bun run test:smoke
```

It drives one journey over HTTP against the running stack, so it covers the joins the rest of the
suite cannot reach: server to supervisor to computer, the gateway deciding before the browser acts,
and the audit row landing. Point it elsewhere with `OPENBOT_API_URL`. Without a deployment it is
skipped by `bun run test` and says what to start when asked for by name.

`bun run test:live-screen` is separate for a related reason and needs no deployment, only this
directory's own dependencies:

```sh
cd agent-computer && bun install
cd .. && bun run test:live-screen
```

It drives the live screen against the real computer process with Chromium and Xvfb: a socket closing
while the browser is still starting, a second connection taking the screen from the first, control
lease checks, the full RFB desktop, and closing Chromium with its native X before reopening it from
the desktop dock.
Those need `agent-computer/src/index.ts`, which imports Playwright at module scope, and `playwright`
is declared only in `agent-computer/package.json`, which `bun install` at the root does not reach. So
without `OPENBOT_LIVE_SCREEN=1` the files skip before importing anything, which is what keeps
`bun run test` and CI working where that dependency was never installed.

## Contribution checklist

- Keep changes focused.
- Keep credentials, service-account JSON, customer data, and transcripts out of source control.
- Put sensitive behavior on the server, not only in the browser.
- Update [configuration](configuration.md), [architecture](architecture.md), or the root [README](../README.md) when behavior changes.
- Run the quality checks above and include the results in the pull request.
