# Desktop updates

OpenBot Desktop updates itself with its signed updater: OpenBot's own window shows a bar when a newer version is out, with **Update and restart**, and the setup window offers it too (`app_update`, read at launch and every six hours). The installation follows the app: on the next Start, an installation that is not on the app's own release is upgraded to it, and its data comes along.

A person can also ask at any time, and every place reads the same feed: **Check for Updates…** in the tray menu on every platform (and under **About OpenBot** in the Mac's OpenBot menu), **Check for updates** in the setup window's **Updates**, and **Check for updates** on the Version row of **Settings › This computer**, which on Windows stands in for the menu bar. Each reads the feed at once and answers: "OpenBot 0.3.2 is up to date.", the newer version with **Update and restart** (named even if the bar was closed on it), or that the feed couldn't be read. The answer is kept, so the bar agrees with it. A build that is offered no updates (internal and candidate builds, and any build without the updater) has no menu item, and its setup window and **Settings › This computer** say "This version of OpenBot doesn't update itself." up front, with no button. Both read that sentence from `shared/desktop-updates.ts`.

The app update itself replaces only the app, on a Mac and on Windows alike. On a Mac the new `OpenBot.app` is put in place of the old one, then OpenBot is stopped and the app restarts. On Windows OpenBot is stopped first, then the installer runs in update mode, which never runs the uninstaller, and starts the new version. Either way the installation, its `.env`, keys and database volumes, and the app's own settings and data stay as they are, and the restarted app's Start is what moves the installation forward. See [Windows updates](releasing.md#windows-updates).

## The upgrade

The app's own release is the tag it was released as, or, for an internal or candidate build, the release it was pinned to. One rule for every build: when the installed version (`.openbot-deployment`) is not that release, Start (`desktop/src-tauri/src/upgrade.rs`):

1. Stops OpenBot.
2. Takes one `pg_dump` of its database (a custom-format archive, checked with `pg_restore --list`), and sets the previous version's files aside in `.openbot-previous/`: `docker-compose.yml`, `container-images.json`, `.openbot-deployment`, the installation records, and what earlier versions laid out for a browser they ran on the desktop (`agent-computer/`, `shared/`, `extension/`), which goes with the previous version.
3. Lays the new version out exactly as Install does.
4. Pulls its images.
5. Starts. Migrations run once, as the `migrate` service Compose completes before it starts `server`.

If any step fails, the previous files go back, the database is restored from the dump, the previous version starts, and the window says so in one sentence before handing over. The next Start tries the upgrade again. If the app stops part way (a crash, Quit, Stop), or the previous version could not be put back, `.openbot-previous/` is still there, and the next Start (Retry, on the screen a failed Start leaves) or Install puts the previous version back first; until then the tray, reopen and Recorder handoff refuse to adopt the half-upgraded installation.

The restore works whoever is connected. The database is published on the host's loopback, so anything on the computer can hold sessions to it and reconnect as soon as they end (a developer's OpenBot server left running on the host held twelve). So every container of the installation's Compose project but Postgres is stopped, the dump is restored in one transaction into a scratch database nobody connects to, and then the database refuses new connections, its sessions are ended, it is dropped (`WITH (FORCE)`) and the scratch database is renamed into its place (`stack::restore_runtime_database`).

An installation an earlier app left running (an installer that closed the app without its Quit, a crash, a force quit) is not shown as it is when it is behind the app's release: the window stays on setup, and Start upgrades it as above. One on the app's release, or newer, is shown at launch, and from then on it is the app's own, as one Start raised is: the menus say it is running, local folder access and the watcher for refused connections run for it, and Stop, Restart and Quit take it down. Both of those answer to the server with the per-run token Start minted and kept only in memory, so for a deployment shown at launch the app reads that token back from the `server` container's environment (`stack::server_host_token`).

A deployment newer than the app is never moved back: its database is already migrated past what the app's release knows. It keeps running, and the app's own update offer catches the app up. Releases before v0.3.0 ran the server on the host; Install lays those out again at the latest release.

`.env`, keys, credentials, profiles, volumes, override files and everything else the installation keeps for itself are never touched.

## What is laid out

Every container runs from an image the release pins by digest, the server's migrations and the tenant package included. So a deployment is the Compose file and image list (`deployment::LAYOUT`), and nothing runs on the host: the person's own browser runs on the one computer, shown in the OpenBot window. Nothing of `server/`, `app/`, `worker/`, `agent-computer/`, `shared/`, `toolkit/`, `scripts/`, `patches/` or `examples/` is laid out, and nothing is installed with Bun. An installation laid out by an earlier app keeps those folders until its next upgrade sets them aside with the previous version; nothing reads them.

## Distribution policy

Source tarballs, image lists and the latest release come from the repository in `<installation>/.openbot-distribution.json` when there is one:

```json
{
  "distributionId": "acme.openbot",
  "repository": "acme/openbot",
  "channel": "stable"
}
```

Otherwise from the build's compiled defaults: distribution ID and repository `CopilotKit/OpenBot`, channel `stable`, which distributors set with `OPENBOT_DISTRIBUTION_ID`, `OPENBOT_RELEASE_REPOSITORY` and `OPENBOT_RELEASE_CHANNEL`. The distribution ID follows the repository when no explicit ID is supplied. The signed app updater checks its own updates against the compiled distribution only.

## Native application delivery

Distributors can opt into the `shell-updater` Cargo feature without upgrading the existing Tauri dependency: the updater is pinned to compatible `2.10.1`. The feature only supplies the updater's configuration from compiled trust (below); checking, the offer, the signed download and the restart are the same `app_update` path as every signed build's. No updater JavaScript plugin permissions are exposed.

Registering the updater plugin makes Tauri read `plugins.updater` from the app configuration, and that block requires a `pubkey`; with none, a feature build panicked at launch. The plugin is registered in one place, `main`'s setup, and only once its configuration exists: a `plugins.updater` block in `tauri.conf.json` is used as written; otherwise the build's compiled trust supplies `pubkey` and `endpoints`; with neither, the plugin is not registered and the build is offered no updates.

Compile the distributor's `OPENBOT_SHELL_UPDATE_PUBLIC_KEY` and credential-free HTTPS `OPENBOT_SHELL_UPDATE_ENDPOINT` into that build. Both are required; downloaded runtime metadata and mutable `.openbot-distribution.json` cannot choose the shell's trust key or endpoint. The plugin verifies signed artifact bytes before OpenBot is stopped, and nothing installs until the person chooses **Update and restart**.

Use `bun desktop/scripts/build-shell-update.ts --bundles <app|nsis|appimage>` with those public settings and `TAURI_SIGNING_PRIVATE_KEY` (plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when applicable). The script uses `tauri.updater.conf.json` to generate updater bundles and `.sig` files, refuses missing signing configuration, and never prints the private key. `collect-shell-update.ts` collects exactly one artifact/signature and a platform manifest fragment. `shell-update-manifest.ts` combines explicitly supplied platform URLs/signature files into the static JSON served at the configured endpoint; it refuses insecure URLs, duplicate platforms and absent signatures. Signature authenticity is checked by Tauri when downloading; the JSON generator does not replace that cryptographic check.

The protected, manually dispatched [signed artifact workflow](../.github/workflows/desktop-shell-updates.yml) builds macOS, Windows and Linux updater bundles and uploads artifacts with manifest fragments for review. Dispatch it from a release tag (**Run workflow**, then **Use workflow from**, **Tags**). It builds exactly the dispatched commit and takes no ref input, because GitHub matches an environment's deployment branch and tag rule against the run's `GITHUB_REF`, the dispatched ref, not against what a job checks out. A first job with no environment and no secrets refuses any dispatch that is not a tag, before reviewers are asked. Configure the `desktop-shell-signing` protected environment with required reviewers, a **Selected branches and tags** deployment rule for release tags only (for example `v*`), its publisher/public endpoint/asset destination variables and private signing key secrets. Protect those tags with a tag ruleset so only release managers can create them. It has read-only repository permissions and does not publish releases or change the live endpoint. Review and combine fragments before a separate explicitly authorized publication. OS installer signing/notarization remains separate from the Tauri updater signature; use the existing OS signing pipeline where required.

No signing key or endpoint is invented, no signed update is published by this task, and no actual application replacement has been exercised without distributor credentials and a disposable installed shell. Code, configuration, workflow, UI and feature compilation are implemented; signed delivery and a live install/relaunch remain unverified.

## Targeted validation

```sh
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --lib upgrade
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --lib --features shell-updater shell_updates
# The upgrade against a real engine: Install's layout, a real pull from a local registry, Start, pg_dump and pg_restore.
OPENBOT_TEST_REGISTRY=127.0.0.1:5050 cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --lib upgrade::real_engine -- --ignored --test-threads=1
cd desktop
bun test ../tests/desktop-updates.test.ts
bun test src/App.test.tsx
bun run typecheck
```

Run desktop tests from `desktop/` to use its own dependency graph instead of the root server/app preload configuration. The real-engine tests need a registry on `OPENBOT_TEST_REGISTRY` (`docker run -d -p 127.0.0.1:5050:5000 registry:2`) and `pgvector/pgvector:pg17` on the engine; each runs in its own Compose project and removes its containers, volume and image tags.
