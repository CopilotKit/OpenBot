# Explicit desktop runtime updates

OpenBot Desktop keeps its installed runtime pin during normal Start and Repair. Runtime updates are explicit: open **Runtime updates** in the existing installation screen, enter an exact release tag, check compatibility, stage its source and images, acknowledge downtime and database recovery, then apply. The native application and runtime have separate delivery paths.

The updater keeps the selected root, saved Docker/Podman engine, Compose project, volume names and supervisor namespace. It replaces managed vendor source leaves in that root. It preserves `.env`, native records, credentials, keys, profiles, workspaces, override files, all of `examples`, and a configured tenant source directory. Generated dependencies/build output is excluded from source comparison, including the exact gitignored `app/src/lib/generated/application-config.ts` file that the app compiler writes from tenant configuration. Other source in that directory remains managed. Modified, added or removed managed source requires upstream integration instead of artifact replacement.

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

`intelligenceCapabilities` must describe capabilities actually provisioned for this installation. It is operator configuration, not inferred from a candidate's requirements. Local manual builds default to distribution ID and repository `CopilotKit/OpenBot`, channel `stable`, and no assumed Intelligence capabilities. The distribution ID follows the compiled repository when no explicit ID is supplied, matching the publisher. Official/fork desktop CI and Windows signing builds compile `github.repository` (including its exact case), the configured distribution ID or that same repository, and the configured channel. A manual fork build must set `OPENBOT_RELEASE_REPOSITORY` and any custom ID/channel explicitly; ambient GitHub context is not runtime trust. Distributors can set compile-time `OPENBOT_DISTRIBUTION_ID`, `OPENBOT_RELEASE_REPOSITORY`, and `OPENBOT_RELEASE_CHANNEL` defaults. Discovery and source/image repair use that configured repository. Candidate manifests must match its ID, repository and channel.

When a newer Desktop lays out more of the tree than the one that installed a release (the stamp records a shorter layout, as every installation from before #858 does), Install lays the same release out again. A plain installation takes that tag's tarball, as it always has. An installation with a verified baseline is laid out from its accepted release's checksum-verified source artifact instead; a managed file that matches neither the baseline nor that artifact is a fork's change, and the layout refuses rather than overwrite it. Missing vendor files are restored, new paths are added, and the baseline grows to cover them. A different version still goes through the explicit update controls.

An existing `.openbot-deployment` pin alone does not prove source provenance. **Verify installed release baseline** downloads `release-manifest.json` from the independently configured repository's exact pinned release and checks its source archive SHA-256. It compares every managed source leaf against that archive, then records `.openbot-release.json` and `.openbot-vendor-baseline.json`. This explicit action never replaces source or customer files. Clean Git status cannot substitute for a published baseline. If the installed release has no publisher-supplied manifest, the publisher must supply one for those exact source bytes; the updater refuses adoption until then.

Manifests come from `https://github.com/<configured-repository>/releases/download/<tag>/release-manifest.json`. HTTPS authenticates the configured host, and SHA-256 binds the source artifact to the manifest. Runtime manifests do not yet have an independent publisher signature. A checksum downloaded with an artifact is not independent publisher authentication.

## Apply and recovery

Staging downloads into a sibling `.NAME.openbot-update-stage` directory (replacing an earlier stage when no update is in progress), validates the shared v1 compatibility contract, checksum, package version, source migration-journal tag and safe archive contents, and pulls digest-pinned images onto the saved engine. It leaves the active source and accepted pin unchanged. Symlinks, traversal, duplicate archive paths, missing required source/images, unsupported APIs/schema and unavailable required Intelligence capabilities are refused.

Apply rechecks the staged inventory and active baseline before stopping anything. It uses the existing owned Stop path; backs up replaced vendor leaves into sibling `.NAME.openbot-update-backup`; brings up only the selected project's Postgres; compares its actual migration hashes/timestamps with the accepted source journal; writes a custom-format `postgres.dump`; and validates the archive using `pg_restore --list`. It stops that temporary database service without deleting volumes, replaces vendor files, and checks Compose project/volume/namespace identity again. Persistent and bind mount service/source/target/type identities are compared from read-only staged Compose output before Stop, retaining the active project directory and customer overrides; swaps or removals refuse without lifecycle mutation. It then reuses existing installation preparation and owned startup, which performs the guarded migration and real API/app readiness checks.

Acceptance additionally requires exact candidate identity from the running API's `/release`, actual candidate container image references, actual database migration hashes/timestamps and a final vendor inventory comparison. The accepted release manifest and pin are promoted only after those checks. The preparation record is rebound to the accepted pin without changing its engine or harness. Once the release is accepted, the stage and backup folders are removed, so the next update stages and applies without manual cleanup. Take your own database backup first if you want one kept past acceptance.

The durable `.openbot-update-journal.json` is written immediately before the first vendor file is replaced, not before. A failed or interrupted database backup therefore leaves the installation exactly as it was: Start works, and the unreferenced backup folder is removed by the next apply. Recovery never involves editing the journal:

- **Before the migration checkpoint** (files being replaced, preparation running, or a quit in between), nothing in the database changed. The next Start or Repair puts the previous release's files back from the backup and removes the journal and backup. Its dependencies were prepared for the candidate, so Start then asks for Repair; Repair carries on into the previous release's installation.
- **After the migration checkpoint** (a port conflict at startup, a failed verification, a quit), the candidate is stopped and its database is compared with the previous release's migration journal. If it still matches, the previous files come back on their own. If it changed, Start, Repair, reopen, the tray and Recorder handoff all refuse, and Runtime updates offers **Restore previous release**. That action stops anything left running, puts the previous files back, starts only Postgres with the previous release's Compose file, and runs `pg_restore --clean --if-exists --create --exit-on-error` from `postgres.dump` only when the database differs. It then checks the migrations again, removes the journal and backup, and stops Postgres without removing volumes. Anything written after the backup is lost. A connection still open to the database makes the restore fail before anything is dropped; the journal and backup stay and the action can be run again.
- **After every runtime check passed** (a quit while acceptance was being written), the next Start finishes acceptance.

Preserve the `.env`/vault encryption keys throughout recovery.

The dump is a backup primitive, not a verified restore rehearsal. PostgreSQL globals, external Intelligence migrations and external writers are not coordinated by this updater. Stop external writers during maintenance. Legacy manifests, publisher signing, a populated prior installation and configured provider/browser access are required for the corresponding end-user rollout proof; unit tests and successful native compilation do not establish that proof.

## Native application delivery

Default builds report signed shell delivery as unconfigured. Distributors can opt into the `shell-updater` Cargo feature without upgrading the existing Tauri dependency: the updater is pinned to compatible `2.10.1`. Rust-only IPC performs explicit check, signed download verification, owned runtime shutdown, installation and native restart; no updater JavaScript plugin permissions are exposed.

Registering the updater plugin makes Tauri read `plugins.updater` from the app configuration, and that block requires a `pubkey`; with none, a feature build panicked at launch. The plugin is registered in one place, `main`'s setup, and only once its configuration exists: a `plugins.updater` block in `tauri.conf.json` is used as written; otherwise the build's compiled trust supplies `pubkey` and `endpoints`; with neither, the plugin is not registered and a check reports shell updates as not configured. Every check still sets the compiled key and endpoint on the updater builder.

Compile the distributor's `OPENBOT_SHELL_UPDATE_PUBLIC_KEY` and credential-free HTTPS `OPENBOT_SHELL_UPDATE_ENDPOINT` into that build. Both are required; downloaded runtime metadata and mutable `.openbot-distribution.json` cannot choose the shell's trust key or endpoint. Shell update metadata must also carry the compiled distributor's `{id, repository, channel}`. The plugin verifies signed artifact bytes before the existing owned runtime is stopped. A changed offered version requires a fresh check; installation requires an explicit restart acknowledgement in the UI.

Use `bun desktop/scripts/build-shell-update.ts --bundles <app|nsis|appimage>` with those public settings and `TAURI_SIGNING_PRIVATE_KEY` (plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when applicable). The script uses `tauri.updater.conf.json` to generate updater bundles and `.sig` files, refuses missing signing configuration, and never prints the private key. `collect-shell-update.ts` collects exactly one artifact/signature and a platform manifest fragment. `shell-update-manifest.ts` combines explicitly supplied platform URLs/signature files into the static JSON served at the configured endpoint; it refuses insecure URLs, duplicate platforms and absent signatures. Signature authenticity is checked by Tauri when downloading; the JSON generator does not replace that cryptographic check.

The protected, manually dispatched [signed artifact workflow](../.github/workflows/desktop-shell-updates.yml) builds macOS, Windows and Linux updater bundles and uploads artifacts with manifest fragments for review. Dispatch it from a release tag (**Run workflow**, then **Use workflow from**, **Tags**). It builds exactly the dispatched commit and takes no ref input, because GitHub matches an environment's deployment branch and tag rule against the run's `GITHUB_REF`, the dispatched ref, not against what a job checks out. A first job with no environment and no secrets refuses any dispatch that is not a tag, before reviewers are asked. Configure the `desktop-shell-signing` protected environment with required reviewers, a **Selected branches and tags** deployment rule for release tags only (for example `v*`), its publisher/public endpoint/asset destination variables and private signing key secrets. Protect those tags with a tag ruleset so only release managers can create them. It has read-only repository permissions and does not publish releases or change the live endpoint. Review and combine fragments before a separate explicitly authorized publication. OS installer signing/notarization remains separate from the Tauri updater signature; use the existing OS signing pipeline where required.

No signing key or endpoint is invented, no signed update is published by this task, and no actual application replacement has been exercised without distributor credentials and a disposable installed shell. Code, configuration, workflow, UI and feature compilation are implemented; signed delivery and a live install/relaunch remain unverified.

## Targeted validation

```sh
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib updates
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib --features shell-updater shell_updates
cargo check --manifest-path desktop/src-tauri/Cargo.toml --bin openbot-desktop
cd desktop
bun test ../tests/desktop-updates.test.ts
bun test src/RuntimeUpdates.test.tsx
bun test src/App.test.tsx
bun run typecheck
```

Run desktop tests from `desktop/` to use its own dependency graph instead of the root server/app preload configuration. Shared fixture conformance, staged-source preservation, checksum/core modification refusal, explicit legacy baseline verification, acceptance-last, interrupted recovery at every phase, a second update after acceptance, and same-version re-layout are tested in the native module against real archives and real files. The fake container engine resolves relative bind mounts against the project directory the way `docker compose config` does (checked against Compose v5.1.4), and holds the migrations table that its `pg_dump` archives and its `pg_restore` puts back. The restore command itself was run against a throwaway `pgvector/pgvector:pg17` container. Full Mac lifecycle acceptance still requires an authorized disposable prior installation and populated database; this work does not mutate a live customer installation as a test. Windows/Linux lifecycle behavior remains covered by the existing cross-platform CI.
