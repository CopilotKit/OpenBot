# Explicit desktop runtime updates

OpenBot Desktop keeps its installed runtime pin during normal Start and Repair. Runtime updates are explicit: open **Runtime updates** in the existing installation screen, enter an exact release tag, check compatibility, stage its source and images, acknowledge downtime and database recovery, then apply. The native application and runtime have separate delivery paths.

The updater keeps the selected root, saved Docker/Podman engine, Compose project, volume names and supervisor namespace. It replaces managed vendor source leaves in that root. It preserves `.env`, native records, credentials, keys, profiles, workspaces, override files, all of `examples`, and a configured tenant source directory. Generated dependencies/build output is excluded from source comparison. Modified, added or removed managed source requires upstream integration instead of artifact replacement.

## Distribution policy and existing installations

Configure publisher identity independently of downloaded metadata in `<installation>/.openbot-distribution.json`:

```json
{
  "distributionId": "acme.openbot",
  "repository": "acme/openbot",
  "channel": "stable",
  "intelligenceCapabilities": ["conversations.v1"]
}
```

`intelligenceCapabilities` must describe capabilities actually provisioned for this installation. It is operator configuration, not inferred from a candidate's requirements. The built-in defaults are `openbot`, `CopilotKit/OpenBot`, `stable`, and no assumed Intelligence capabilities. Distributors can set compile-time `OPENBOT_DISTRIBUTION_ID`, `OPENBOT_RELEASE_REPOSITORY`, and `OPENBOT_RELEASE_CHANNEL` defaults. Discovery and source/image repair use that configured repository. Candidate manifests must match its ID, repository and channel.

An existing `.openbot-deployment` pin alone does not prove source provenance. **Verify installed release baseline** downloads `release-manifest.json` from the independently configured repository's exact pinned release and checks its source archive SHA-256. It compares every managed source leaf against that archive, then records `.openbot-release.json` and `.openbot-vendor-baseline.json`. This explicit action never replaces source or customer files. Clean Git status cannot substitute for a published baseline. If the installed release has no publisher-supplied manifest, the publisher must supply one for those exact source bytes; the updater refuses adoption until then.

Manifests come from `https://github.com/<configured-repository>/releases/download/<tag>/release-manifest.json`. HTTPS authenticates the configured host, and SHA-256 binds the source artifact to the manifest. Runtime manifests do not yet have an independent publisher signature. A checksum downloaded with an artifact is not independent publisher authentication.

## Apply and recovery

Staging downloads into a sibling `.NAME.openbot-update-stage` directory, validates the shared v1 compatibility contract, checksum, package version, source migration-journal tag and safe archive contents, and pulls digest-pinned images onto the saved engine. It leaves the active source and accepted pin unchanged. Symlinks, traversal, duplicate archive paths, missing required source/images, unsupported APIs/schema and unavailable required Intelligence capabilities are refused.

Apply rechecks the staged inventory and active baseline before stopping anything. It uses the existing owned Stop path; backs up replaced vendor leaves into sibling `.NAME.openbot-update-backup`; brings up only the selected project's Postgres; compares its actual migration hashes/timestamps with the accepted source journal; writes a custom-format `postgres.dump`; and validates the archive using `pg_restore --list`. It stops that temporary database service without deleting volumes, replaces vendor files, and checks Compose project/volume/namespace identity again. It then reuses existing installation preparation and owned startup, which performs the guarded migration and real API/app readiness checks.

Acceptance additionally requires exact candidate identity from the running API's `/release`, actual candidate container image references, actual database migration hashes/timestamps and a final vendor inventory comparison. The accepted release manifest and pin are promoted only after those checks. The preparation record is rebound to the accepted pin without changing its engine or harness. Keep the vendor/database backup until the release is accepted operationally; archive it before applying another release. The updater does not silently overwrite an earlier backup.

A durable `.openbot-update-journal.json` blocks ordinary Start/Repair after interruption. Before the migration checkpoint, an ordinary preparation failure restores previous vendor files and leaves the previous accepted release repairable. Once migration may have run, failure stops the candidate and retains its source, journal and database backup. Source rollback cannot undo SQL. Keep the runtime stopped, inspect the journal's phase and `backup` path, and either complete the candidate's guarded migration/startup or restore `postgres.dump` into the same preserved database under operator control before restoring previous vendor files. Preserve the `.env`/vault encryption keys throughout recovery. Do not delete the journal merely to bypass a failed migration.

The dump is a backup primitive, not a verified restore rehearsal. PostgreSQL globals, external Intelligence migrations and external writers are not coordinated by this updater. Stop external writers during maintenance. Legacy manifests, publisher signing, a populated prior installation and configured provider/browser access are required for the corresponding end-user rollout proof; unit tests and successful native compilation do not establish that proof.

## Native application delivery

Signed desktop shell auto-update delivery is not configured in the default build. Runtime controls report this explicitly. OS installer signing and runtime manifest checksums are distinct from Tauri updater artifact signing. Distributors must provide their own trusted update endpoints and public key, publish signed platform artifacts, and retain the existing cross-platform desktop CI. No signing key or endpoint is invented by this updater.

## Targeted validation

```sh
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib updates
cargo check --manifest-path desktop/src-tauri/Cargo.toml --bin openbot-desktop
cd desktop
bun test ../tests/desktop-updates.test.ts
bun test src/App.test.tsx
bun run typecheck
```

Run desktop tests from `desktop/` to use its own dependency graph instead of the root server/app preload configuration. Shared fixture conformance, staged-source preservation, checksum/core modification refusal, explicit legacy baseline verification, acceptance-last and interrupted/preparation recovery are tested in the native module. Full Mac lifecycle acceptance still requires an authorized disposable prior installation and populated database; this work does not mutate a live customer installation as a test. Windows/Linux lifecycle behavior remains covered by the existing cross-platform CI.
