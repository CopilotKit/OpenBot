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

The policy file contains `distributionId`, `repository` and `channel`, as described in [local updates](local-updates.md). The metadata hash must be independently approved; it does not establish publisher authenticity by itself. Use repeated `--values` for ordered customer files. These files remain separate and unchanged. Their Secret references, tenant package mounts, configuration and storage choices remain the customer's source of truth. `--timeout` bounds migration/rollout work: Helm and each `kubectl wait`/`rollout status` get it, and no process is killed before it. Plan/check does not call the cluster or execute backup commands.

Apply also keeps what the release already has. It reads the release's user-supplied values with `helm get values` and records them as `previous-values.json` under `--output`, then passes them to Helm ahead of the customer files, so a value set with `--set` at install survives and later files win. The new chart's own defaults still apply to anything nobody set, which is what `helm upgrade --reset-then-reuse-values` does. Plan/check reads no cluster state, so it plans without those values. When the customer's files or the release's values name an `image.repository` other than the release's (a registry mirror), that repository is kept and only the tag and digest are pinned. The digest fixes the bytes whichever registry serves them.

For a declared database schema transition, preflight locally renders the checksum-validated target chart with the exact customer values and pinned release values. The effective render must include the target image's guarded `scripts/migrate.ts` Job as a `pre-upgrade` hook. Disabling migrations, omitting the Job or replacing it with a different image/runner refuses promotion before any cluster operation.

## Live Helm execution

Replace `plan` with `apply` and add `--acknowledge-interruption`. Only an existing release is upgraded; first installation remains the chart's existing Helm workflow. The tool verifies the current server workload against the supplied accepted digest before mutation and writes private operation/recovery records under `--output`.

Maintenance transitions pause the release's CronJobs, wait for their recorded active Jobs, scale server admission to zero and wait for old server pods to leave before running the backup command. The backup executable must create and verify the backup identified by `--backup-reference`, exit nonzero on failure, and use the customer's existing database/cloud credentials. A preexisting backup alone is insufficient for a maintenance transition: the command is required so it runs after quiescence. The tool does not invent a cloud snapshot implementation or silently assume a successful empty command produced a restorable backup.

Helm receives the exact chart archive, the release's previous values, the customer values, and a generated file containing only the pinned image and release annotations. For a release that Helm 4 applies server-side (`helm get metadata` reports `applyMethod: ssa`), the upgrade passes `--force-conflicts`. The chart's declared values then take back the CronJob suspension and replica count this tool set with kubectl, as client-side apply does. Without it, the upgrade stops on a field-manager conflict after the migration hook has already run. `--wait`, `--wait-for-jobs` and a timeout bound the operation. The existing pre-upgrade migration hook blocks workload promotion on migration failure and retains the database's advisory lock and history-reach checks. The special first installation with bundled PostgreSQL continues using an ordinary migration Job so the database can be created first. That distinction is unchanged.

After the candidate is verified, every CronJob this operation suspended is put back. One whose `spec.suspend` the chart declares (`routines.suspend`) keeps the value Helm set from values; every other one, such as the attachments and computer cullers, is resumed. A CronJob that was already suspended before the promotion stays suspended. `routines.suspend` is available for a deliberate longer maintenance window; suspension does not cancel Jobs already running. API rollout is verified, then the command checks workload image/release annotations and calls the running server's `/release` endpoint inside the server container before writing `accepted-release.json`. An HPA-owned deployment is taken out of a maintenance zero-replica state explicitly before verification.

No `--atomic`/automatic rollback is used. A failed migration can commit durable changes, so restoring an old Helm revision does not restore SQL.

A refusal before anything changed (a plan refusal, or a current workload that does not match the accepted release) writes no journal. A failure after quiescing began but before Helm ran (a CronJob wait, the scale-down or the backup) puts the replica count and CronJobs back exactly and records `failed`, which does not block another attempt. A failure once Helm has started records `recovery-required`. A maintenance transition then keeps server writes and scheduled work paused; a rollback-compatible transition without downtime is left serving, because the previous code accepts the resulting schema. Shutdown failure is reported alongside the original error. Previous replica counts and CronJob suspension states are retained for operator recovery. A `recovery-required` journal blocks another promotion from the same output directory; retain one directory per installation rather than bypassing its lock with a new path.

Operators must review configuration/storage differences and ensure no other controller reopens write admission during maintenance. The tool serializes one operator invocation locally; it does not introduce a cluster-wide deployment operator or replace customer deployment concurrency policy. Backup restore, forward recovery and old-code compatibility remain explicit operator decisions.

## GitOps output

The `gitops` action writes `release-values.json`, `proposed-release.json` and `ORDERING.md` without applying a Helm release, calling kubectl or changing a cluster. Schema transitions also render the chart locally for the migration preflight above. Commit the pinned values and chart identity to the customer's deployment repository, preserving Secret references and customer values separately.

The ordering document requires a successful guarded migration phase before server replacement, then readiness/image/release verification and customer workflow acceptance. A controller that only renders Helm templates must implement that ordering: it cannot assume Helm's hook execution exists. No tested Argo CD or Flux synchronization integration is claimed by generated values alone. Reverting Git does not reverse a database migration.

Unit/integration fixtures verify invocation order, identity refusal, chart integrity and failure evidence. Helm render checks cover both upgrade hooks and bundled-database first installation. A real populated database rollout/recovery and the configured agent actually using its browser tool and rendering a graphical component remain required before claiming a verified customer deployment.
