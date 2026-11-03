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
| `OPENBOT_RELEASE_POLICY` | Reviewed JSON containing `compatibility` and `upgrade`, shown below. Required; publication fails in preflight before pushing any image if it is missing or invalid. |

This example shows the complete policy shape. Replace versions, schema identities and capabilities with those verified for the release. Use actual database migration history identities; the example does not declare the current repository's migrations compatible.

```json
{
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
export OPENBOT_RELEASE_POLICY="$(cat reviewed-release-policy.json)"
bun scripts/release-manifest.ts --validate-policy
```

The release PR/version/changelog gates remain in place. The additional compatibility setup is intentional: an existing publisher must declare it before its next release rather than silently make a rollback promise. The pipeline archives the exact source commit with `git archive`, computes SHA-256 locally, and attests the source archive, both manifest formats, and image digests using the publishing workflow's OIDC identity. No release is published by these local commands.

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

Opt in with `OPENBOT_UPSTREAM_UPGRADES=true`. Configure the upstream repository and initial baseline above. Optionally set `OPENBOT_UPGRADE_CHECKS` to JSON argv arrays, for example `[["bun","install","--frozen-lockfile"],["bun","test"],["bun","run","typecheck"]]`. Include meaningful customer component and migration regression commands. Commands run sequentially in the candidate without shell interpolation. No automatic migration-history rewrites or codemods are applied.

Manually dispatch **Propose upstream upgrade** from `main` with an exact release tag and its independently verified 40-character commit. It checks the fetched tag resolves to that commit, requires the old baseline to be an ancestor on both sides, preserves Git ancestry, runs the declared checks, and proposes a branch and PR. It never merges, releases or deploys the result. The fork's subsequent reviewed release uses its own publication workflow and identity.

The equivalent local command is:

```sh
bun scripts/integrate-upstream.ts \
  --repository . --output ../openbot-upstream-candidate \
  --branch upgrade/upstream-v0.3.0 --base refs/heads/main \
  --baseline <previous-upstream-SHA> \
  --upstream https://github.com/CopilotKit/openbot.git \
  --tag refs/tags/v0.3.0 --commit <verified-upstream-SHA> \
  --checks '[["bun","install","--frozen-lockfile"],["bun","test"]]' \
  --report ../upstream-report.json
```

The output must be a new path outside the original checkout. The script creates a standalone clone without shared hardlinks, preserving the original branch, index, remotes and committed/uncommitted files. Dirty source is reported and excluded from the candidate; commit the intended work before integrating if it belongs in the proposed release. [Git documents the clone isolation options](https://git-scm.com/docs/git-clone).

Conflicts keep the candidate's conflict markers and unmerged index for resolution. Failing checks keep command output and an unaccepted candidate. The CLI exits 2 in either case. Reports live at `<candidate>/.git/openbot-upgrade-report.json` and the requested report path. The workflow retains the report and a candidate archive, including `.git`, for 14 days; it creates no PR for a conflicted or failed candidate. Resolve and verify that retained candidate deliberately. Never use an automatic reset, migration journal edit, data deletion, or key regeneration to make integration appear successful.

The report says `accepted: false` even when checks pass. PR review must evaluate changed paths, configuration/schema changes, declared downtime, recovery class and actual customer workflows. A successful textual merge is preparation for a release; activation belongs to the desktop, explicit local-update, or customer Kubernetes deployment workflow.
