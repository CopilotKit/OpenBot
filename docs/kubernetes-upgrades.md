# Kubernetes release promotion

`bun scripts/update.ts kubernetes plan|apply|gitops` is operator tooling around the existing Helm chart. The running application receives no cluster deployment permission. Promotion uses the manifest's exact monolithic `openbot` image digest, chart archive checksum, independent distribution policy and explicit customer values files.

The release pipeline packages the existing chart and records its version, release-asset URL and SHA-256 in `release-manifest.json`. Download the approved package; this command checks its checksum before invoking Helm. The separate desktop `server` image cannot substitute for the monolithic image used by chart server/computer workloads.

```bash
bun scripts/update.ts kubernetes plan \
  --current /srv/accepted-release.json \
  --candidate /srv/approved/release-manifest.json \
  --candidate-sha256 "$APPROVED_MANIFEST_SHA256" \
  --policy /srv/customer-update-policy.json \
  --chart /srv/approved/openbot-0.1.4.tgz \
  --namespace customer --release openbot \
  --values /srv/customer-values.yaml \
  --output /srv/promotions/openbot \
  --backup-reference /srv/backups/this-promotion \
  --backup-command-json '["/usr/local/bin/customer-database-backup","--verify"]'
```

The policy file contains `distributionId`, `repository` and `channel`, as described in [local updates](local-updates.md). The metadata hash must be independently approved; it does not establish publisher authenticity by itself. Use repeated `--values` for ordered customer files. These files remain separate and unchanged. Their Secret references, tenant package mounts, configuration and storage choices remain the customer's source of truth; supply the complete accepted values rather than relying on chart defaults. `--timeout` bounds migration/rollout work. Plan/check does not call the cluster or execute backup commands.

For a declared database schema transition, preflight locally renders the checksum-validated target chart with the exact customer values and pinned release values. The effective render must include the target image's guarded `scripts/migrate.ts` Job as a `pre-upgrade` hook. Disabling migrations, omitting the Job or replacing it with a different image/runner refuses promotion before any cluster operation.

## Live Helm execution

Replace `plan` with `apply` and add `--acknowledge-interruption`. Only an existing release is upgraded; first installation remains the chart's existing Helm workflow. The tool verifies the current server workload against the supplied accepted digest before mutation and writes private operation/recovery records under `--output`.

Maintenance transitions pause the release's CronJobs, wait for their recorded active Jobs, scale server admission to zero and wait for old server pods to leave before running the backup command. The backup executable must create and verify the backup identified by `--backup-reference`, exit nonzero on failure, and use the customer's existing database/cloud credentials. A preexisting backup alone is insufficient for a maintenance transition: the command is required so it runs after quiescence. The tool does not invent a cloud snapshot implementation or silently assume a successful empty command produced a restorable backup.

Helm receives the exact chart archive, customer values, and a generated file containing only pinned image/release annotations. `--wait`, `--wait-for-jobs` and a timeout bound the operation. The existing pre-upgrade migration hook blocks workload promotion on migration failure and retains the database's advisory lock and history-reach checks. The special first installation with bundled PostgreSQL continues using an ordinary migration Job so the database can be created first. That distinction is unchanged.

Target CronJobs resume under their target chart/customer suspension policy after the guarded migration when Helm reconciles target workloads. `routines.suspend` is available for a deliberate longer maintenance window; suspension does not cancel Jobs already running. API rollout is verified, then the command checks workload image/release annotations and calls the running server's `/release` endpoint inside the server container before writing `accepted-release.json`. An HPA-owned deployment is taken out of a maintenance zero-replica state explicitly before verification.

No `--atomic`/automatic rollback is used. A failed migration can commit durable changes, so restoring an old Helm revision does not restore SQL. Failed promotion leaves a durable `recovery-required` journal and attempts to keep server writes and scheduled work paused. Shutdown failure is reported alongside the original error. Previous replica counts and CronJob suspension states are retained for operator recovery. A pending journal blocks another promotion from the same output directory; retain one directory per installation rather than bypassing its lock with a new path.

Operators must review configuration/storage differences and ensure no other controller reopens write admission during maintenance. The tool serializes one operator invocation locally; it does not introduce a cluster-wide deployment operator or replace customer deployment concurrency policy. Backup restore, forward recovery and old-code compatibility remain explicit operator decisions.

## GitOps output

The `gitops` action writes `release-values.json`, `proposed-release.json` and `ORDERING.md` without applying a Helm release, calling kubectl or changing a cluster. Schema transitions also render the chart locally for the migration preflight above. Commit the pinned values and chart identity to the customer's deployment repository, preserving Secret references and customer values separately.

The ordering document requires a successful guarded migration phase before server replacement, then readiness/image/release verification and customer workflow acceptance. A controller that only renders Helm templates must implement that ordering: it cannot assume Helm's hook execution exists. No tested Argo CD or Flux synchronization integration is claimed by generated values alone. Reverting Git does not reverse a database migration.

Unit/integration fixtures verify invocation order, identity refusal, chart integrity and failure evidence. Helm render checks cover both upgrade hooks and bundled-database first installation. A real populated database rollout/recovery and the configured agent actually using its browser tool and rendering a graphical component remain required before claiming a verified customer deployment.
