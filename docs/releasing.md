# Releasing

A release is one person choosing a version, and a reviewed pull request doing everything else. No
step involves a terminal, a tag pushed by hand, or an image built on somebody's laptop.

## Cutting one

1. Check `## Unreleased` in [CHANGELOG.md](../CHANGELOG.md) reads the way you want it to. It is the
   release notes. Nothing is generated from commit subjects, because a commit subject is written for
   the person reading the diff and these notes are for the person deciding whether to upgrade.
2. Run **Create release PR** from the Actions tab, choosing `patch`, `minor` or `major`. Use
   `dry_run` first if you want to see the version and the notes without opening anything.
3. Review the pull request it opens. It updates `package.json`, promotes the changelog's
   `## Unreleased` heading to `## X.Y.Z`, and moves the Helm chart's `appVersion` and the desktop
   Cargo package/lockfile to the same version. Tauri reads its version directly from the root
   `package.json`.
4. Merge it. That is the publish.

Merging is the trigger, so a release is always a reviewed commit on `main`.

## Desktop build versions

The root `package.json` is the release version source. CI rejects drift in the desktop Cargo
manifest or lockfile. The release workflow updates those files automatically; after a manual
root version change, run `bun desktop/scripts/desktop-version.ts sync`.

Internal desktop artifacts use `X.Y.Z-internal.g<commit>` so testers can identify the source
revision. Both desktop CI and protected Windows signing prepare this version before compilation
and packaging. The artifact includes `build-version.json` with the full commit and release version.

To build locally, from the repository root:

```sh
bun desktop/scripts/desktop-version.ts internal
cd desktop
APPLE_SIGNING_IDENTITY=- bun run tauri build --config src-tauri/tauri.build-version.conf.json --bundles dmg
```

Use `release` instead of `internal` to prepare the plain release version. This only builds an
artifact; it does not publish a release. macOS keeps numeric system version fields and stores
the full internal identifier in `OpenBotBuildVersion` inside the app's `Info.plist`. Windows
retains the full identifier in `ProductVersion` and `FileVersion`; its fixed numeric fields
contain the release number. The protected signing job checks both embedded string versions.

Ad-hoc signed Mac builds require the first-open exception described in
[Apple's instructions](https://support.apple.com/en-us/102445). They are for internal testing
and are not Apple-notarized. See [signed Mac builds](#signed-mac-builds-and-the-updater) for the
ones people install, and [Windows signing](windows-signing.md) for signed NSIS builds.

## Signed Mac builds and the updater

[Desktop macOS signing](../.github/workflows/desktop-macos-signing.yml) builds OpenBot with the
Developer ID certificate, notarizes and staples both the `.app` and the `.dmg`, and produces the
archive the in-app updater installs. It runs one native runner per architecture (`macos-15` for
Apple silicon, `macos-15-intel` for Intel) and fails unless each build passes all three of:

```sh
codesign --verify --deep --strict --verbose=2 OpenBot.app
spctl -a -t exec -vv OpenBot.app
xcrun stapler validate OpenBot.app
```

An ad-hoc build fails every one of them, which is why it needs "Open Anyway".

When it runs:

- pull requests and pushes to `main` that touch the desktop run only **Updater regressions
  (no Apple access)**. It holds no secrets.
- **Actions → Desktop macOS signing → Run workflow** with `signing-mode: developer-id` signs any
  ref and keeps the results as Actions artifacts for 14 days. Set `release-tag` to an existing
  release, e.g. `v0.2.1`, to also attach the `.dmg` files, the updater archives and their `.sig`
  files, and `latest.json` to it. After a release is published, run this against the release tag.
- a `v*` tag pushed by a person does the same thing automatically. The tag `publish-release.yml`
  creates does not start it, because GitHub does not start workflows from events made with
  `GITHUB_TOKEN`. That is why the step above is manual for now.

Signing imports the certificate into a temporary keychain made for the run, and always deletes
that keychain afterwards, even when an earlier step failed.

Only the signing job produces updater artifacts. `bundle.createUpdaterArtifacts` lives in
`desktop/src-tauri/tauri.macos-signing.conf.json`, which that job alone passes to Tauri, because
Tauri refuses to finish any bundle that asks for updater artifacts without
`TAURI_SIGNING_PRIVATE_KEY`. In the base config it would break ordinary desktop CI and the local
build above. Do not rename the overlay `tauri.macos.conf.json`: Tauri merges that filename into
every Mac build automatically.

### The updater

The app checks `https://copilotkit.ai/openbot/desktop/latest.json` once at launch. If a newer
version is listed, the window offers **Update and restart**. Nothing installs without that click.
`copilotkit.ai` redirects that address to
`https://github.com/CopilotKit/OpenBot/releases/latest/download/latest.json`, so the newest
non-draft release is always the one offered.

`latest.json` names a version and, for `darwin-aarch64` and `darwin-x86_64`, an archive URL and
that archive's minisign signature. The app verifies the signature against the public key in
`plugins.updater.pubkey` in `tauri.conf.json` and refuses any archive that does not match. That
key pair is the Tauri updater key. It is not the Developer ID certificate, and it is not the
Windows Key Vault certificate. Losing the private key means installed apps can never update
again, so keep it in 1Password as well as in the environment.

A failed check says nothing, because an offline laptop is not a problem to report. A failed
install shows its error.

### One-time setup

Create the protected GitHub environment `macos-signing` with required reviewers, and add these
environment **secrets**:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | The Developer ID Application certificate and private key, exported as `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | The identity name, e.g. `Developer ID Application: <Company> (<TEAMID>)` |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_KEY_P8` | The contents of that key's `AuthKey_<id>.p8`. The job writes it to a temporary file and sets `APPLE_API_KEY_PATH` |
| `TAURI_SIGNING_PRIVATE_KEY` | The Tauri updater private key (`tauri signer generate`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | That key's password |

The job also reads the existing `OPENBOT_GOOGLE_MODEL_OAUTH_*` variables and secret, as the other
desktop builds do.

Put the matching updater **public** key in `plugins.updater.pubkey` in
`desktop/src-tauri/tauri.conf.json`. The signing job refuses to run while that field still holds
`REPLACE_WITH_UPDATER_PUBKEY`.

## What merging does

`publish-release.yml` runs on every push to `main` and starts by deciding whether the commit is a
release at all. It asks the API for the pull request that produced the commit, and requires that the
head branch matches `release/publish/vX.Y.Z`, that the branch is in this repository, and that the
pull request carries the `release` label. A fork can name a branch anything; it cannot add a label.

Then, in order:

- the version in the tree is checked against the branch that is publishing it, and the changelog is
  checked for a section with that number
- one image is built and pushed to `ghcr.io/copilotkit/openbot`, tagged with the version, the commit
  and `latest`
- the services `docker-compose.yml` can build are published too, one image each, at
  `ghcr.io/copilotkit/openbot-<service>`. Those are `linux/amd64` and `linux/arm64`, built on native
  runners of each architecture and joined into one manifest list, because the machines pulling them
  are laptops as well as servers. `.github/published-images.json` is the list, and CI fails if it
  stops matching the Dockerfiles in the tree
- a build provenance attestation is signed with the workflow's OIDC identity and pushed alongside
  every one of them
- the commit is tagged and a GitHub Release is created, carrying the changelog section as its notes
  and `container-images.json` as an asset

## Deploying a release

`container-images.json` pins a digest for every image the release published. Deploy those, not tags:

```sh
gh release download v0.1.0 --pattern container-images.json
docker run -p 3001:3001 --env-file .env \
  "$(jq -r .images.openbot.reference container-images.json)"
```

The same file is how a machine runs the stack without building any of it. Each key under `images`
is a service, so the references can be read straight out of it:

```sh
export COMPUTER_IMAGE="$(jq -r '.images["agent-computer"].reference' container-images.json)"
export SUPERVISOR_IMAGE="$(jq -r .images.supervisor.reference container-images.json)"
export BOT_IMAGE="$(jq -r '.images["agent-bot"].reference' container-images.json)"
export LANGGRAPH_IMAGE="$(jq -r '.images["agent-langgraph"].reference' container-images.json)"
export SERVER_IMAGE="$(jq -r .images.server.reference container-images.json)"
export IMAGE_PULL_POLICY=missing
docker compose up -d
```

`IMAGE_PULL_POLICY=missing` is what turns those names into pulls; without it every one of those
services builds from source, because a service with a `build` section builds by default whatever
its image is called. A pull that fails still falls back to building, so a machine with no toolchain
wants the `build` sections overridden away rather than this variable alone.

A tag can be moved to point at a different image; a digest cannot. The same digest that CI smoke
tested is the one that runs, and rolling back is the same command with an earlier version.

On Kubernetes the chart takes the same digest as `image.digest`; see
[charts/openbot/README.md](../charts/openbot/README.md#pin-the-image-by-digest).

Before deploying, you can check an image is the one this repository built. Every published image
carries its own attestation:

```sh
gh attestation verify oci://ghcr.io/copilotkit/openbot:v0.1.0 -R CopilotKit/OpenBot
gh attestation verify oci://ghcr.io/copilotkit/openbot-supervisor:v0.1.0 -R CopilotKit/OpenBot
```

## What has to be green

Branch protection should require one check, `verify`, which fails unless every other job succeeded.
A job added to `ci.yml` is covered by it without anybody updating a list.

| check | what it would catch |
| --- | --- |
| `format, lint, types` | the ordinary things, across every workspace including `agent-computer` and the supervisor |
| `types (agent-computer)`, `types (supervisor)` | a type error in either deployable package, each checked on its own install |
| `native types` | a type error in the `mobile` app, which installs from its own npm lockfile |
| `computer (real browser)` | the agent-computer behaviour only a real Chromium shows, such as a password reaching the snapshot a model reads, a session cookie lost on restart, or WebRTC leaving around the egress filter |
| `tests` | a decision made wrongly, in isolation |
| `chart` | a Helm values file that renders a server which cannot start, across the self-hosted, EKS, EKS sandbox, GKE and AKS targets |
| `python harness regressions` | a provider-boundary regression in the Python Bot harnesses |
| `startup (macos-latest)`, `startup (windows-latest)` | the app's serve-or-build cache deciding wrongly on macOS or Windows |
| `build` | the app not compiling |
| `migrations` | a schema change with no migration, or a snapshot that has drifted |
| `image` | an image that builds but does not boot, or a supervised service that respawns |
| `component dockerfiles` | a Dockerfile a release would publish that no longer builds, or one the publish list has stopped covering |

`image` matters more than its position suggests. Everything above it can pass on a tree whose image
never starts, because nothing else here runs the thing it ships. It builds the container, boots it
with embedded PostgreSQL, waits for `/api/capabilities`, and fails if a supervised service is
respawning.

These checks run again, against the release commit, when the release PR is merged. They gate the
publish rather than the proposal, which is why the release PR arriving without its own checks does
not matter: a pull request opened by a workflow does not trigger them.

**No secrets are required to release.** CI and both release workflows use only the built-in
`GITHUB_TOKEN`. The desktop build workflows also read `OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET`.
Signed desktop builds are the exception: they read the `macos-signing` and `windows-signing`
environments described above and in [Windows signing](windows-signing.md).

## The one thing CI cannot do

The smoke journey in `tests/smoke` is the only check that proves the parts are wired to each other:
the server reaches the supervisor, the supervisor builds a computer, the gateway decides before the
browser acts, and the trail records it. It cannot run in CI, and this is not a gap to be closed
later.

OpenBot only runs in Intelligence mode, and `loadConfig` refuses to start without the project's
Intelligence values, which a hosted runner has no business holding. The `image` check gets around
this with placeholder values, because nothing is contacted at start-up, but the journey asserts
`licenseStatus` is `valid`, and no placeholder can make that true.

So it is a step a person takes, on a machine with real Intelligence credentials, before merging
the release PR:

```sh
bash scripts/start.sh
export OPENBOT_SMOKE_COOKIE='better-auth.session_token=...'   # from a signed-in browser
bun run test:smoke
```

The session is the second half of "a machine with real credentials": the routes the journey proves
are behind `requireUser`, so a run without one answers 401 three times and says nothing about the
release. See [development.md](development.md#quality-checks) for where the cookie comes from.

The release PR asks for the result in a comment. That is deliberately a person rather than a robot:
it is the one gate that cannot be automated, so it is the one gate worth naming.
