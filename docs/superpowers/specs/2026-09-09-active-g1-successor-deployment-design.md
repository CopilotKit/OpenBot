# Active G1 successor deployment

## Goal

Deploy a new immutable OpenBot commit while the Netsfera host is already running an active G1
manifest. The transition must retain the current lock contract, complete Compose overlay set,
external-route check, immutable image binding, private evidence, and automatic rollback guarantees.

The first use promotes the production deployment from
`38c9ae68d5de9c2aef3e3eb9e28bad020e321152` to the successor containing the one-click interactive
handoff continuation. The mechanism is general for later schema-neutral G1 successors.

## Current constraint

The active helper validates the checked-out commit, exact image identity, functional overlay,
exact-image overlay, and rendered Compose checksum against
`/etc/netsfera/bot-zero-trust/openbot-g1-activation.manifest` before a public mutation. Changing the
checkout first therefore makes the helper reject the next command, while changing only the image or
manifest breaks the same binding in the other direction.

The existing staging and activation scripts deliberately describe the first G0-to-G1 transition.
They require the reviewed G0 commit and cannot safely be reused for an already active G1 deployment.
The successor path must update source and binding as one locked transaction rather than weakening
those checks.

## Chosen approach

Add a dedicated, commit-reviewed active-G1 promotion controller and a trusted wrapper. The wrapper
accepts a Git bundle, its SHA-256, the exact `refs/netsfera-review/<target>` advertised ref, the
40-character target commit, and controller bytes. It verifies the bundle and confirms the controller
bytes are exactly the blob stored at the target commit before executing them.

The controller acquires the existing deployment lock before preflight and retains it while staging
the candidate with the current manifest active, replacing source/manifest, applying, verifying, and
performing any rollback. It never invokes bare Compose. Diagnostic candidate rendering uses the
helper's existing `--reviewed-controller` interface; live mutations use only the public
manifest-bound helper.

Temporarily deactivating G1 was rejected because the current deployment has no first-transition
evidence file suitable for the old activation manager and because it would add avoidable downtime.
Editing the running container or manifest by hand was rejected because it is not durable and has no
complete rollback proof.

## Inputs and authority

Every promotion requires:

- an immutable candidate commit advertised by the verified bundle;
- the currently deployed commit, discovered from the active manifest and verified against source;
- an approved external HTTPS route and expected HTTP status supplied as explicit arguments;
- a maintenance window and named backup/rollback executor; and
- the existing root-owned mode-0600 deployment lock.

The controller never reads deployment inputs from `.env`, never prints environment files or
attestations, and never accepts a branch, arbitrary Compose selector, image name, overlay path, or
rollback destination from the caller.

## Preflight and staging

Before mutation the controller:

1. Acquires the shared deployment lock and validates its inode, owner, group, and mode.
2. Requires the systemd unit to be active, exited and job-free.
3. Requires a canonical active G1 manifest with no legacy marker.
4. Confirms the source checkout is clean and its HEAD equals the manifest's candidate commit.
5. Confirms the running OpenBot container is healthy and uses the manifest-bound exact image.
6. Runs the complete runtime inventory verifier and checks the approved external route.
7. Rejects a target equal to the current commit and rejects any target not advertised by the
   already-verified bundle.
8. Rejects a candidate whose `server/drizzle` tree differs from the current commit. Version one is
   intentionally schema-neutral so rollback never has to guess whether database restoration is safe.

The controller creates a private staging directory, checks the candidate out there without moving
`/opt/openbot/source`, builds the ordinary OpenBot Dockerfile under a commit-derived local tag, and
runs the existing stopped-image package verification. It generates a root-owned mode-0600 exact
image overlay and renders the complete candidate Compose configuration through
`openbot-compose-v1.sh --reviewed-controller ... config --format json`. The render must select the
new exact image and retain every required service and overlay.

## Backup

Before changing source or the active manifest, the controller creates a unique mode-0700 directory
under `/opt/openbot/.deploy-backups`. It writes mode-0600 copies of:

- a source Git bundle containing the current deployed commit;
- a PostgreSQL custom-format dump made through the manifest-bound helper;
- the current activation manifest;
- the functional and exact-image overlays;
- current source, image, container and route identities; and
- a `SHA256SUMS` file verified immediately after creation.

A failed dump, bundle, copy, checksum, or checksum verification stops the promotion before mutation.
The backup path is emitted, but file contents and checksums are retained in private evidence rather
than printed to the conversation.

## Locked activation transaction

With staging and backup complete and the same lock still held, the controller repeats source,
runtime, policy and route checks. It then:

1. Detaches `/opt/openbot/source` at the exact target commit.
2. Verifies the functional overlay in the final checkout matches the staged digest.
3. Re-renders the complete candidate stack using the final source path.
4. Writes a canonical successor manifest to a private temporary file.
5. Atomically renames the successor manifest over the active manifest.
6. Calls only `openbot-compose-v1.sh --lock-held-fd <fd> up --detach --remove-orphans`.
7. Requires the source HEAD, manifest, exact image, complete runtime inventory, health and external
   route to agree with the successor.
8. Restarts the OpenBot service through the manifest-bound helper and repeats the same checks,
   proving that the new binding survives a real restart without an automatic restart loop.

The new canonical manifest keeps the existing field order and invariants. It binds the successor
commit, image reference and identities, functional and exact overlay digests, and final rendered
Compose checksum. No legacy activation marker is created.

## Rollback

A trap becomes active immediately before the source checkout changes. Until final verification is
recorded, any error or termination:

1. Restores the prior source commit in detached mode.
2. Restores the prior functional overlay, exact-image overlay and activation manifest from the
   verified backup.
3. Applies the prior manifest through the public helper.
4. Requires the prior exact image, complete runtime inventory, health and approved route to return.

Because schema-changing candidates are rejected before mutation, the database dump is evidence and a
last-resort operator asset rather than something an automatic rollback restores. If rollback cannot
re-establish every prior invariant, the controller exits with a distinct critical status and leaves
the backup and evidence intact.

The successful path never deletes the prior image or backup. Cleanup of old candidate images and
deployment backups is a separate reviewed operation.

## Evidence and auditability

The controller writes a root-owned mode-0600 evidence file in the backup directory containing only
non-secret identities and outcomes: current and target commits, image/configuration identities,
overlay and render digests, backup verification, container health, route status, restart evidence,
and whether rollback ran. It does not contain environment values, credentials, database contents,
attachment metadata, or manifest contents.

Success prints the target commit, final image reference, backup path, evidence path, health result,
external status and `restart_observed=true`. Failure prints a stable stage and reason without dumping
command environments or HTTP bodies.

## Files and interfaces

The implementation adds:

- `deploy/netsfera/promote-active-g1-v1.sh`: the locked staging, activation, verification and
  rollback controller;
- `deploy/netsfera/verify-reviewed-active-g1-wrapper.sh`: bundle/ref/blob verification and ephemeral
  controller launcher; and
- focused tests using isolated fixtures and command doubles for bundle validation, lock ownership,
  preflight, schema-change refusal, backup failure, staged rendering, atomic manifest replacement,
  apply, restart, route checks and rollback fault injection.

The existing helper, systemd unit, G0-to-G1 scripts, activation manager and public runtime behavior
remain unchanged.

## Verification and first production use

Local verification includes formatting, shell syntax, the new controller/wrapper tests, existing
deployment-script tests where the host supplies their Linux dependencies, application tests,
typechecking and build. The controller must pass tests that inject a failure at every mutation stage
and prove the prior binding is restored.

For the first production promotion:

1. Build the reviewed bundle from the final clean candidate commit and verify its advertised ref.
2. Transfer only the bundle and wrapper/controller bytes extracted from that commit, with reviewed
   ownership and modes.
3. Execute the wrapper with `https://bot.netsfera.es` and expected status `200` during the approved
   window.
4. Retain the private backup and evidence paths.
5. Confirm production reports the final commit, healthy workload, successful real restart and HTTP
   200.
6. Exercise the handoff receipt link and confirm it creates exactly one continuation turn before the
   genuine approval card.

## Acceptance criteria

- An active manifest-bound G1 deployment can be promoted to an immutable schema-neutral successor
  without entering an unbound runtime state.
- No live Compose mutation bypasses the authoritative helper or loses the supervisor/ERP overlays.
- A failure or signal after mutation restores the exact prior source, manifest, image and healthy
  route, or reports a distinct critical rollback failure.
- The successor survives a real helper restart and remains bound to its exact commit and image.
- The first deployment runs the one-click handoff continuation while retaining authenticated human
  approval for the actual ERP transfer.
