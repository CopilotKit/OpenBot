# Netsfera document agents v0.0.7 rollout

This runbook is the production path from an immutable local candidate to the exact live image. It
is for the first transition from the reviewed G0 baseline
`ff5aa7ebd8ac798887017bfa1f5a471483b0c499` onto the OpenBot v0.0.7 release `9aedb57`. Use the
candidate's 40-hex SHA everywhere; never substitute a branch name. Do not access the host until the
maintenance gate is complete.

## Roles, inputs, and stop conditions

Record these concrete inputs in the private execution log before any host mutation:

- approved immutable candidate SHA;
- approved maintenance window;
- backup owner;
- rollback owner; and
- approved external Tailscale/ingress route and its expected HTTP result.

Stop without changing the host if any input is missing, or if any of these conditions is true:

```text
netsfera-openbot.service is not active
the Compose helper is absent or config -q fails
the source tree is dirty
any required service/container is absent, stopped, or unhealthy where it has a healthcheck
the source commit is not ff5aa7ebd8ac798887017bfa1f5a471483b0c499
the activation marker or manifest unexpectedly exists
the approved external Tailscale/ingress route is unknown
the database dump fails
```

All Compose operations in this runbook use only
`/usr/local/lib/netsfera/openbot-compose-v1.sh`; do not invoke Compose directly or supply Compose
selection overrides. The reviewed helper is also the production path after activation: its manifest
is the binding for the exact image and overlays.

Before staging, perform the read-only host checks from `/opt/openbot`:

```bash
set -euo pipefail
systemctl is-active --quiet netsfera-openbot.service
test -x /usr/local/lib/netsfera/openbot-compose-v1.sh
/usr/local/lib/netsfera/openbot-compose-v1.sh config --quiet
test -z "$(git -C /opt/openbot/source status --porcelain)"
test "$(git -C /opt/openbot/source rev-parse HEAD)" = \
  ff5aa7ebd8ac798887017bfa1f5a471483b0c499
test ! -e /etc/netsfera/bot-zero-trust/enable-openbot-g1
test ! -e /etc/netsfera/bot-zero-trust/openbot-g1-activation.manifest
for service in openbot postgres bot-backend-ts supervisor; do
  ids="$(/usr/local/lib/netsfera/openbot-compose-v1.sh ps --all -q "$service")"
  test -n "$ids"
  for id in $ids; do
    state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
    test "$state" = 'running healthy' || test "$state" = 'running none'
  done
done
state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' openbot-computer-general-assistant)"
test "$state" = 'running healthy' || test "$state" = 'running none'
```

Confirm the approved route separately before and after activation, using the approved request and
expected result recorded above. Do not infer the route from an environment file or expose either
environment file in the execution log.

## Backup before checkout or build

On the host, create a unique private backup directory under `/opt/openbot/.deploy-backups` with mode
0700. Source, database dump, checksum list, and every retained evidence file are mode 0600. A failed
dump, bundle, checksum, or checksum verification is a stop condition.

```bash
set -euo pipefail
backup_dir="/opt/openbot/.deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-v007-document-agents"
install -d -o root -g root -m 0700 "$backup_dir"
git -C /opt/openbot/source bundle create "$backup_dir/openbot-source.bundle" HEAD
cd /opt/openbot
/usr/local/lib/netsfera/openbot-compose-v1.sh exec -T postgres \
  pg_dump -U openbot -d openbot -Fc > "$backup_dir/openbot.pgdump"
chmod 0600 "$backup_dir/openbot-source.bundle" "$backup_dir/openbot.pgdump"
sha256sum "$backup_dir/openbot-source.bundle" "$backup_dir/openbot.pgdump" \
  > "$backup_dir/SHA256SUMS"
chmod 0600 "$backup_dir/SHA256SUMS"
sha256sum -c "$backup_dir/SHA256SUMS"
```

Keep the resulting `OK` output and the checksums with the deployment evidence. Do not read or
expand environment files to perform this backup.

## Build the reviewed bundle locally

Run this in the clean candidate checkout. It binds the bundle to the immutable commit before any
artifact is transferred:

```bash
set -euo pipefail
candidate_sha="$(git rev-parse HEAD)"
artifact_dir="$(mktemp -d)"
chmod 0700 "$artifact_dir"
bundle_path="$artifact_dir/openbot-v007-document-agents.bundle"
deploy/netsfera/create-reviewed-bundle.sh "$candidate_sha" "$bundle_path"
bundle_sha256="$(sha256sum "$bundle_path" | awk '{print $1}')"
git bundle verify "$bundle_path"
git bundle list-heads "$bundle_path" | grep -Fx \
  "$candidate_sha refs/netsfera-review/$candidate_sha"
```

Transfer the bundle and only the reviewed wrapper, installer, and staging-script bytes extracted from
that same `candidate_sha`. On the host, give transferred executable bytes owner `root:root` and mode
0700; give transferred bundle and evidence files mode 0600. The trusted wrappers compare the
transferred bytes they consume with blobs in the verified bundle and remove transferred files when
they exit.

## Install the reviewed host lock contract

After the backup and before staging, install the reviewed helper/lock contract once through its
trusted wrapper. It creates its own private mode-0700 evidence directory below
`/root/openbot-incoming`, records the replaced files and SHA-256 values in a mode-0600 evidence file,
and verifies that the service continues to use the helper. Retain the emitted
`OPENBOT_LOCK_EVIDENCE` path for the rollback owner.

```bash
/root/openbot-incoming/verify-reviewed-host-lock-wrapper.sh \
  /root/openbot-incoming/openbot-v007-document-agents.bundle \
  "$bundle_sha256" "refs/netsfera-review/$candidate_sha" "$candidate_sha" \
  /root/openbot-incoming/install-openbot-lock-contract.sh
```

The wrapper extracts the reviewed host package from the verified candidate, rather than accepting a
directory copied from a mutable checkout. Stop if installation or its verification fails. Do not
continue to stage using the prior helper. The wrapper deletes its supplied bundle and installer on
exit, so transfer a fresh bundle with the same recorded SHA-256 alongside the stage wrapper before
the next step.

## Stage, inspect, and approve

Run the trusted wrapper on the host with its transferred, commit-bound inputs. The advertised ref is
always `refs/netsfera-review/$candidate_sha`; retain the evidence path it emits under
`/root/openbot-incoming` and protect it as mode 0600.

```bash
/root/openbot-incoming/verify-reviewed-g1-stage-wrapper.sh \
  /root/openbot-incoming/openbot-v007-document-agents.bundle \
  "$bundle_sha256" "refs/netsfera-review/$candidate_sha" "$candidate_sha" \
  /root/openbot-incoming/stage-reviewed-g1.sh
```

This stages without applying. Review the evidence against the local candidate: candidate commit,
image/configuration/index/descriptor identities, G0 baseline, functional-overlay SHA-256,
exact-image-overlay SHA-256, candidate render SHA-256, `live_container_health=healthy`, and
`stored_action_policy=absent-or-reviewed-equivalent`. Staging checks that the live container ID and
image still equal the emitted `g0_container_id` and `g0_image_id` before completing. Confirm the marker
and manifest remain absent. No `live_container_unchanged` field is emitted or required.

The effective `action_policy` row must be absent or equal to the reviewed `mode`, `deny`, and `allow`
values. JSON layout/key order do not matter; CEL text and rule ordering remain exact, since the first
matching rule is part of Audit. A permissive policy, a dry-run policy, or a stale restrictive policy
blocks staging, pre-apply, and post-apply. These scripts only read the row. Reconciliation is an
explicit operator action with its own review; do not delete or overwrite it automatically.

The stopped candidate probe validates the exact image's package content only: it creates a stopped
container, reads copied package bytes with an isolated offline reader, and checks
`jefe-erp` is disabled, `recolector-documentos` is enabled, its skills are exactly
`skill-creator` and `crear-proveedor-documental`, and neither target has a capability grant at this
stage. It does not start candidate services, synchronize the package, or prove host service health.
The staging unit fixture simulates `docker cp` and the reader's output. Its pass is not evidence of
real image contents. The real stopped-image probe must pass on the production candidate during
staging and again at pre-apply; never replace that gate with unit-fixture output. The probe does not
prove service start or restart; those are verified below.

For additional local coverage, build the package-only
`server/tests/fixtures/netsfera-document-image.Dockerfile` and pass its immutable image reference to
`verify-netsfera-document-image.sh` with a private temporary parent directory. This exercises real
`docker create`, `docker cp`, and the isolated reader, without starting the source image. It remains
supplemental evidence: the production image must pass the same probe on the host before apply.

Stop on any evidence mismatch. Do not activate until a reviewer approves this evidence.

## Activate, verify, and prove persistence

Use the shared lock. Validate its root ownership and mode 0600, acquire it on FD 9, and retain that
FD through activation, apply, and verification:

```bash
set -euo pipefail
cd /opt/openbot
test "$(stat -c '%u:%g %a' /var/lock/openbot-deployment.lock)" = '0:0 600'
exec 9>/var/lock/openbot-deployment.lock
flock -n 9
# The activation manager invokes the commit-bound pre-apply verifier immediately
# before installing the manifest, passing this same FD 9. It validates the
# effective stored policy as well as the real stopped-image probe and G0 state.
/usr/local/lib/netsfera/manage-openbot-g1-activation-v1.sh \
  --lock-held-fd 9 activate /root/openbot-incoming/g1-stage-REPLACE.evidence
/usr/local/lib/netsfera/openbot-compose-v1.sh --lock-held-fd 9 up --detach --remove-orphans
/opt/openbot/source/deploy/netsfera/verify-openbot-runtime.sh --lock-held-fd 9
/opt/openbot/source/deploy/netsfera/verify-staged-g1.sh \
  --lock-held-fd 9 post-apply /root/openbot-incoming/g1-stage-REPLACE.evidence
/usr/local/lib/netsfera/manage-openbot-g1-activation-v1.sh \
  --lock-held-fd 9 verify /root/openbot-incoming/g1-stage-REPLACE.evidence
# Both route arguments come from the approved maintenance inputs, not an env file.
/opt/openbot/source/deploy/netsfera/restart-staged-g1.sh --lock-held-fd 9 \
  /root/openbot-incoming/g1-stage-REPLACE.evidence "$approved_route" "$expected_http_status"
flock -u 9
exec 9>&-
```

Replace the evidence placeholder with the reviewed path actually emitted by staging. Never create the
legacy marker. Then, still under the reviewed helper path, verify the exact staged image identity,
healthy containers, manifest binding, approved external route, and absence of restart loops.
`restart-staged-g1.sh` uses the authoritative helper's `restart openbot` operation under the inherited
FD; a repeated no-op `up` is insufficient. It records the before/after container IDs, `StartedAt`
timestamps and restart counts, requires a changed ID or start timestamp, and rejects new automatic
restarts. Before and after restart it checks the complete required inventory, exact image,
manifest/overlay/render binding, stored policy, and the approved route's expected HTTP status.
The health wait is bounded to 120 seconds (at most 600 if explicitly configured); route requests are
bounded to 30 seconds each. A missing/stopped service cannot pass an empty loop, and a running
service without a healthcheck is accepted. Preserve its `restart_observed=true`, health output,
exact references/digests, render hash, route results and relevant audit event IDs as mode-0600 evidence.
This exercises the manifest-bound helper used by `netsfera-openbot.service`; do not call
`systemctl restart` while holding FD 9, since the unit must acquire that lock itself.

## Post-deploy agent configuration and acceptance

After the candidate is healthy and persistent across the helper restart:

1. In **Admin → Components**, confirm `Approval` (`askApproval`) and `Choice` (`askChoice`) are
   published and are not withheld from `recolector-documentos`. If a component must be allowed,
   confirm that change is audited.
2. Open the **Jefe ERP** agent dialog, open **Handoff**, and enable only **Recolector de documentos**.
3. Confirm the audit trail records the directional change and the data view shows exactly one
   `kind = 'bot'`, `ref = 'recolector-documentos'` grant on `jefe-erp`.
4. Confirm there is no reverse grant. Do not grant an MCP tool to either agent in this release.

Exercise the live journey in this order: existing channels/history remain reachable; Jefe ERP cannot
browse and hands a document request to the collector. The native handoff records the task,
constraints and expected result in a collector-owned direct conversation accessible to that person.
It posts a receipt with a continuation link and audits `awaiting-human-continuation`, including the
source thread and destination thread/channel references. The headless delivery has no browser, Choice or
Approval actions: the person must open the linked collector conversation and continue there before
those actions occur. Confirm the collector model did not run during that receipt and Jefe truthfully
reports that the interactive work is pending. Then the collector reaches a reviewed host but an
unreviewed host is refused with its rule; login uses human takeover and then returns work; and
`/crear-proveedor-documental` interviews, rehearses, and renders a native save card. Saving creates a
personal skill without silently attaching it; **Put it on a Bot** attaches it to the collector.
Neither a provider skill nor its attachment can enable computer access: `computer_access` persists in
the agent package/configuration, and only its explicit `enabled` state opens the entitlement gate.
CEL is evaluated afterwards for each acting call; it may authorize or refuse that call, but it cannot
change `disabled` to `enabled`.

A provider run enumerates candidates first, shows the required selection fields, uses `askChoice` for
individual selection or `askApproval` for the complete set, and acts only on the approved set. The
selection table includes provider, document identifier, issue date, period, amount, currency, file
type, and source whenever the portal exposes them.
Rejection performs no document action. Login, password, 2FA, CAPTCHA, consent, account switching,
and unsafe/sensitive steps require human takeover. Enter, Space and submit-on-type activations are
denied even from an unnamed focus or a neutral field; request takeover for those actions. Ordinary
non-submit typing and non-activating keys remain available. Credentials and one-time codes are never recorded
in a skill or chat. To add a provider, first review the portal and authentication hosts, update and
redeploy the reviewed policy artifact, and only then invoke `/crear-proveedor-documental`. Skill
creation never edits policy.

OpenBot v0.0.7 has no governed binary-download tool. The truthful result when the approved document
is ready is `human_save_required`: open it, request human control for the final save, and never claim
the agent downloaded it. Do not use `curl` with copied browser credentials as a workaround. The
future [governed `computer_download` contract](../superpowers/specs/2026-09-04-netsfera-document-agents-design.md#logical-download-and-future-native-tool)
defines the replacement boundary without changing the provider skill's discovery or approval phases.

## Rollback boundary

Keep the source SHA, exact image references/digests, render hash, backup checksums, health output,
external journey result, entitlements, grants, and audit event IDs in the private evidence directory.
If a failure occurs before migrations, use the reviewed helper/manifest path to restore the recorded
source and image, then verify the G0 runtime. If migrations ran, stop for the approved database-restore
decision: do not perform a code-only rollback or assume schema compatibility.
