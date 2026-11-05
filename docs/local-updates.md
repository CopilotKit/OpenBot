# Explicit local updates

`bun scripts/update.ts local check|plan|apply` updates a known source checkout at an explicit maintenance boundary. It preserves the checkout root, customer files, Compose project and volume identities. Regular startup does not discover or install a newer release.

The first supported layout is a clean Git checkout whose exact HEAD matches its accepted `.openbot-release.json`. Fetch and accept the candidate source commit before applying it. An unknown/non-Git installation, dirty tracked source, committed divergence from the accepted distribution, non-fast-forward target, or target changes to customer paths is refused. Use `scripts/integrate-upstream.ts` to create a separate integration candidate; review/build that distribution's release first. The updater never merges arbitrary upstream changes into production.

## Trust and preparation

Keep the distribution policy separately from downloaded metadata, for example `customer-update-policy.json`:

```json
{"distributionId":"acme.openbot","repository":"acme/openbot","channel":"stable"}
```

Obtain the candidate `release-manifest.json` and its approved SHA-256 from your release approval process. Verify publisher provenance using the configured repository before trusting that checksum. A checksum downloaded with untrusted content does not authenticate its publisher. The command requires the expected metadata hash, checks distribution identity/compatibility, and uses the exact source commit already present in Git. It does not download arbitrary archive URLs.

For initial adoption, an operator must verify the accepted manifest against actual checkout HEAD, running artifacts, configuration/API versions and available Intelligence capabilities before recording `.openbot-release.json`. There is no automatic guess or forced baseline adoption. The existing database migration-history/advisory-lock guards remain authoritative.

```bash
bun scripts/update.ts local plan \
  --root /srv/openbot --topology image \
  --policy /srv/customer-update-policy.json \
  --candidate /srv/approved/release-manifest.json \
  --candidate-sha256 "$APPROVED_MANIFEST_SHA256" \
  --backup-dir /srv/openbot-backups
```

Use `apply` with the same arguments plus `--acknowledge-interruption` after accepting the plan. An incompatible plan exits with code 2; execution errors exit with code 1. `check` is an alias for the read-only plan. Extra customer directories can be declared with repeated `--customer-path` arguments. External Intelligence capabilities may be supplied using repeated `--intelligence-capability`; absent those arguments, the accepted manifest's previously required capabilities form the baseline.

## Execution and topology

Image topology first pulls the release's exact image digests through the candidate's own Compose file, with `IMAGE_PULL_POLICY=missing` (Compose skips any service whose policy is `never`), and confirms each digest is in the engine. A failed or partial pull refuses before anything is stopped. It then stops only the selected Compose project's server and worker, preserves the database/computer/profile/workspace resources, creates a custom-format PostgreSQL backup and validates its table of contents, advances source with `git merge --ff-only`, runs the existing guarded migration service with `up --no-build --no-deps --exit-code-from migrate`, and starts only server/worker with `--no-build`. The migration container’s exit code is authoritative and its diagnostics remain available; `run --no-build` is not a supported Compose command. It verifies `/health`, every `/release` identity field (read from inside the server container, because `/release` answers only a caller on the server's own machine) and running image references before recording acceptance. No `down --volumes`, broad process kill, new keys, migration restamping or state-directory move occurs. Existing computers/supervisor remain intact.

Host topology requires this installation's app, API and routine worker already stopped. It refuses occupied app/API ports and this installation’s running routine worker. On macOS/Linux, startup and update checks scope worker discovery to the checkout’s working directory, so a known worker in another installation can remain active. Unknown worker ownership is refused. It then creates/validates a PostgreSQL backup, advances source, runs `bun install --frozen-lockfile`, the existing `server/scripts/migrate.ts`, and `scripts/start.sh`. It passes candidate `OPENBOT_BUILD_*` identity without rewriting `.env`. `start.sh` builds the checked-out source's images under their usual local names; the release's digest references are not handed to it, because Docker refuses to tag a build with a digest. Ordinary host restarts load the accepted identity. Host ownership checks require macOS/Linux `lsof` and `pgrep`; host updates on Windows are refused.

Both modes require Docker Compose and PostgreSQL backup tools. A bundled Compose database uses `pg_dump`/`pg_restore` inside its existing PostgreSQL container. Host/external database backups require host `pg_dump` and `pg_restore` with connectivity, and `pg_dump` refuses a server newer than itself, so the host tools must be at least the server's major version (the bundled Compose database is PostgreSQL 17). libpq reads a connection URI only as a `dbname` argument, never from `PGDATABASE`, so `DATABASE_URL` is split into `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` and the libpq variable for each query option it carries. The password travels in the environment, never in a command argument. A URL with several hosts, or with a query option libpq has no variable for, is refused at plan time. The backup directory and files are private, and the database dump is streamed rather than decoded as text.

For an image database URL targeting the `postgres` service, preflight requires its database/user to match that service's `POSTGRES_DB`/`POSTGRES_USER`, port 5432, and no URI query overrides. A different database on the same host is refused before any service is stopped; it requires a reviewed backup path rather than a backup of the container's default database. Connection credentials are never printed or added to visible command arguments by this check.

The target Compose file is resolved with the original project directory/name and existing customer override. Changes to existing volume names, mount identities, computer namespace, tenant path, database identity or preserved customer paths require explicit integration. Custom `COMPOSE_FILE`/`COMPOSE_ENV_FILES` layouts are refused. This adapter supports Docker Compose; it does not select or migrate a desktop's Podman engine. Docker's selected context must already point to the installation's engine.

No step is killed on a timer: a pull, backup, migration, install or startup runs to its end, because one cut off partway is worse than one that takes long. `--timeout` bounds only the readiness wait.

The accepted source remains pinned in Git. `docker compose restart` retains existing accepted container images; recreating image-mode services manually must also use the accepted manifest's digest overrides. The tool does not rewrite customer `.env` image settings or change the behavior of an arbitrary bare `docker compose up`.

## Interrupted operations and recovery

The updater takes `.openbot-update.lock`, writes `.openbot-update-journal.json` before lifecycle changes, and retains previous/candidate source archives, the prior manifest, customer-state archive, database dump and its checksum in an operation-specific backup directory. `local status --root /srv/openbot` reads the journal. The operation lock survives process interruption; inspect it before manually removing a stale lock.

After migration begins, failure never automatically resets source or restores SQL. The accepted manifest remains unchanged, owned candidate services are stopped, and the journal records `recovery-required`. Normal `scripts/start.sh` is blocked by any unaccepted journal; only the matching active update operation may enter its startup phase. A kill/engine failure is retained in recovery diagnostics.

Before durable mutation, restore/restart the accepted source only after verifying HEAD and backup match the journal. After potential schema mutation, decide whether previous code is compatible with the resulting schema; otherwise restore a matching database/configuration/key backup or perform forward recovery under operator control. Archive the failed journal and clear a stale lock only after that decision and verification. Removing a journal is not database recovery.

These commands implement lifecycle execution and tested failure boundaries. A populated previous-release database migration/restore rehearsal and the signed-in browser-plus-graph user workflow are separate deployment acceptance checks. Active runs may be interrupted after acknowledgement; a generalized run-drain API and automatic backup restoration are not implemented.
