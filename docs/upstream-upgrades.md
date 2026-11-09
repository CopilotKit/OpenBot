# Releases and upstream integration

OpenBot keeps two actions separate: integrating upstream into customer source, and deploying an accepted distribution release. Ordinary startup does neither. Existing services, customer files and durable data stay in their current locations.

## Configure a distribution

The publishing workflow uses `ghcr.io/<lowercase owner>/<lowercase repository>` and its component suffixes. A fork publishes its own source and images. `container-images.json` remains available for existing installers; new consumers use `release-manifest.json`, `openbot-source.tar.gz`, and `release-provenance.sigstore.json` from the same GitHub release.

Set these repository Actions variables before merging the next release PR:

| Variable | Meaning |
| --- | --- |
| `OPENBOT_DISTRIBUTION_ID` | Stable installation policy identity; defaults to `owner/repository`. |
| `OPENBOT_RELEASE_CHANNEL` | Trusted channel, default `stable`. |
| `OPENBOT_UPSTREAM_REPOSITORY` | Upstream `owner/repository`, default `CopilotKit/openbot`. |
| `OPENBOT_UPSTREAM_COMMIT` | Exact upstream ancestor for a fork's first integration/release; later integrations record `.openbot-upstream.json`. Remove the bootstrap variable after accepting the first recorded integration so it does not override future baselines. |

## Write the release policy

The compatibility and upgrade policy is `release-policy.json` at the repository root, reviewed with the release like any other change. Publication reads it from the release commit itself, never from a repository variable or the working tree, and refuses it in preflight, before any image is pushed, unless its `version` is the version being released. A policy left over from the previous release names that release, so it cannot ship again under the new one. Every `fromVersions` entry must be an earlier release version. The database transition is checked against the migrations rather than trusted: `compatibility.database.to` must be the last migration in `server/drizzle/meta/_journal.json` at the release commit, and `compatibility.database.from` must be the last migration at the tag of each `fromVersions` release, so every starting release needs its tag. A refusal names the value to write. The schema is `shared/release-policy.schema.json`.

Write the next release's policy before merging its release PR, in that PR or before it. This example shows the complete shape. Replace versions, schema identities and capabilities with those verified for the release. Database identities are the last migration tags in `server/drizzle/meta/_journal.json`.

```json
{
  "$schema": "./shared/release-policy.schema.json",
  "version": "v0.3.0",
  "compatibility": {
    "launcherApi": 1,
    "configSchema": 1,
    "extensionApi": 1,
    "database": {
      "from": ["customer-db-schema-before"],
      "to": "customer-db-schema-after",
      "rollbackCompatible": false
    },
    "intelligenceCapabilities": []
  },
  "upgrade": {
    "fromVersions": ["v0.2.0"],
    "requiresDowntime": true,
    "recovery": "restore-backup"
  }
}
```

`restart-previous` is accepted only when `rollbackCompatible` is true. Declare it only after verifying the previous application against the resulting database state. `restore-backup` requires an operator-approved restore of the matching data and keys; changing an artifact pointer does not reverse migrations. API versions start at 1 and must match exactly. Empty `fromVersions` or database `from` arrays deliberately permit no upgrade from an installed release.

Validate locally using the same command as release CI (Git history must include the selected upstream baseline):

```sh
export GITHUB_REPOSITORY=acme/openbot
export GITHUB_SHA="$(git rev-parse HEAD)"
export VERSION=v0.3.0
export OPENBOT_UPSTREAM_COMMIT=<exact-upstream-ancestor>
bun scripts/release-manifest.ts --validate-policy
```

The release PR/version/changelog gates remain in place. The additional compatibility setup is intentional: an existing publisher must declare it before its next release rather than silently make a rollback promise. The pipeline archives the exact source commit with `git archive`, computes SHA-256 locally, and attests the source archive, both manifest formats, and image digests using the publishing workflow's OIDC identity. No release is published by these local commands.

Each release also packages the checked-out Helm chart, including locked dependencies. Its exact chart version, release-specific GitHub asset URL, and SHA-256 appear in `artifacts.chart`; the `.tgz` is uploaded and attested with the source. Local artifact generation accepts `OPENBOT_CHART_PATH` and `OPENBOT_CHART_VERSION` together. The filename must be `openbot-<chart-version>.tgz`.

A rerun of a release that failed partway completes it. `helm package` stamps the time it ran, and the provenance bundle is signed again on every run, so a rerun never produces the same bytes even when nothing changed. Instead the workflow downloads what was already published and compares by content: the source archive and chart by the files inside them (paths, modes and contents, not timestamps or compression), `container-images.json` and `release-manifest.json` by their parsed values. Published bytes are kept and only missing assets are uploaded, so the manifest's checksums and the attestation describe exactly what is downloadable. The provenance bundle is kept when it attests the same assets, and replaced only when the published one attests assets that were never published. Any real difference, such as a rerun that rebuilt the images under new digests, is refused; publish a new release version instead.

Published server and monolithic images bake public `OPENBOT_BUILD_VERSION`, `OPENBOT_BUILD_COMMIT`, `OPENBOT_BUILD_DISTRIBUTION_ID`, `OPENBOT_BUILD_REPOSITORY`, and `OPENBOT_BUILD_CHANNEL` at build time. Host adapters pass these from the authenticated candidate. `GET /release` returns `{version,commit,distributionId,repository,channel}` from the startup build environment with `Cache-Control: no-store`, or 503 when identity is incomplete. It never reads the accepted installation sidecar while verifying a candidate. `/health` remains liveness. The base Compose file forwards build arguments to all uses of the server image and deliberately does not set empty runtime identity overrides. Always verify source/image digests as well as the endpoint; environment metadata alone is not artifact authentication.

## Authenticate before planning

Installation policy must be configured independently of downloaded metadata. Pin distribution ID, repository and channel. Never accept a candidate's own repository as the trust configuration. Verify downloaded metadata first, then check its artifact SHA-256 and immutable image references:

```sh
gh attestation verify release-manifest.json \
  --repo acme/openbot \
  --signer-workflow acme/openbot/.github/workflows/publish-release.yml
gh attestation verify openbot-source.tar.gz \
  --repo acme/openbot \
  --signer-workflow acme/openbot/.github/workflows/publish-release.yml
```

The portable bundle supports verification with `--bundle release-provenance.sigstore.json` when online attestation discovery is unavailable. Consumers must fail if verification cannot complete. Checksums alone do not authenticate the publisher. Repository plans without GitHub artifact-attestation support cannot use this publication path until they supply supported provenance; the workflow has no unsigned fallback. [GitHub documents verification policy and flags](https://cli.github.com/manual/gh_attestation_verify).

`parseReleaseManifest`, `planUpgrade`, and `classifySource` live in `shared/release-manifest.ts`, with schema and shared native fixtures beside them. `source.modified` records a distribution's changes relative to upstream; it does not make every installed fork release locally modified. `sourceKind` compares installed files with their own accepted distribution baseline. External customer configuration can be `extended`; local managed/core edits or committed divergence require source integration. Unknown baselines block artifact replacement.

## Prepare a fork integration

Opt in with `OPENBOT_UPSTREAM_UPGRADES=true`. Configure the upstream repository and initial baseline above. By default the candidate is checked the way CI checks it: every `run` step of the candidate's own `.github/workflows/ci.yml` `static` and `test` jobs, in order, with bash `-eo pipefail`, in each step's working directory and with the job's and step's environment, against the same `pgvector/pgvector:pg17` database service the CI `test` job has. A step that cannot run that way (an expression, a condition, another shell) fails the run rather than being skipped. CI runs the `test` job as several shards, but the shard reaches it through an action step, which this skips, so here the whole suite runs once and checks its own test floor. To run something else, set `OPENBOT_UPGRADE_CHECKS` to JSON argv arrays, for example `[["bun","install","--frozen-lockfile"],["bun","run","test:ci"]]`; those run sequentially in the candidate without shell interpolation. Include meaningful customer component and migration regression commands. No automatic migration-history rewrites or codemods are applied.

Manually dispatch **Propose upstream upgrade** from `main` with an exact release tag and its independently verified 40-character commit. It never merges, releases or deploys the result. The fork's subsequent reviewed release uses its own publication workflow and identity.

The workflow has two jobs, because the checks execute upstream code that nobody has reviewed yet:

1. **integrate and test** can only read the repository. It checks the fetched tag resolves to that commit, requires the old baseline to be an ancestor on both sides, preserves Git ancestry, runs the checks, and hands a ready candidate over as a Git bundle.
2. **push and propose** holds the write token and runs no candidate code. In a fresh clone of `main` it accepts the bundle only if its content is exactly a clean merge of a `main` commit with the verified upstream commit, recomputed with `git merge-tree`, plus the `.openbot-upstream.json` record and nothing else. It pushes with hooks disabled and opens the PR from its own verification, not from the first job's report.

GitHub's own `GITHUB_TOKEN` cannot push changes to `.github/workflows`, and a pull request it opens gets CI runs that wait for a maintainer to approve them. To lift both limits, create a GitHub App with repository contents, pull requests and workflows write, install it on the fork, and set the `OPENBOT_UPGRADE_APP_CLIENT_ID` variable and the `OPENBOT_UPGRADE_APP_PRIVATE_KEY` secret. Without them the workflow falls back to `GITHUB_TOKEN`, says in the PR body and the job summary that CI must be started by hand, and refuses, before pushing anything, an upstream release that changes workflows. [GitHub documents both limits](https://docs.github.com/en/actions/concepts/security/github_token) and [the App token action](https://github.com/actions/create-github-app-token).

The equivalent local command is:

```sh
bun scripts/integrate-upstream.ts \
  --repository . --output ../openbot-upstream-candidate \
  --branch upgrade/upstream-v0.3.0 --base refs/heads/main \
  --baseline <previous-upstream-SHA> \
  --upstream https://github.com/CopilotKit/openbot.git \
  --tag refs/tags/v0.3.0 --commit <verified-upstream-SHA> \
  --checks ci --report ../upstream-report.json
```

`--checks ci` needs the database the CI `test` job uses, at the `DATABASE_URL` and `TEST_DATABASE_URL` that job sets.

The output must be a new path outside the original checkout. The script creates a standalone clone without shared hardlinks, preserving the original branch, index, remotes and committed/uncommitted files. Dirty source is reported and excluded from the candidate; commit the intended work before integrating if it belongs in the proposed release. [Git documents the clone isolation options](https://git-scm.com/docs/git-clone).

Conflicts keep the candidate's conflict markers and unmerged index for resolution. Failing checks keep command output (the last 64 KiB of each stream) and an unaccepted candidate. The CLI exits 2 in either case. Reports live at `<candidate>/.git/openbot-upgrade-report.json` and the requested report path. The workflow retains the report and a candidate archive, including `.git`, for 14 days, and a ready candidate's bundle beside them; it creates no PR for a conflicted or failed candidate. Resolve and verify that retained candidate deliberately. Never use an automatic reset, migration journal edit, data deletion, or key regeneration to make integration appear successful.

The report says `accepted: false` even when checks pass. PR review must evaluate changed paths, configuration/schema changes, declared downtime, recovery class and actual customer workflows. A successful textual merge is preparation for a release; activation belongs to the desktop, explicit local-update, or customer Kubernetes deployment workflow.
