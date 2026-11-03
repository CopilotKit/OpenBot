# Releasing

A release is one person choosing a version, and a reviewed pull request doing everything else. No
step involves a terminal, a tag pushed by hand, or an image built on somebody's laptop.

## Cutting one

1. Check `## Unreleased` in [CHANGELOG.md](../CHANGELOG.md) reads the way you want it to. It is the
   release notes. Nothing is generated from commit subjects, because a commit subject is written for
   the person reading the diff and these notes are for the person deciding whether to upgrade.
2. Run **Create release PR** from the Actions tab, choosing `patch`, `minor` or `major`. Leave
   `kind` as `stable`. Use `dry_run` first if you want to see the version and the notes without
   opening anything.
3. Review the pull request it opens. It updates `package.json`, promotes the changelog's
   `## Unreleased` heading to `## X.Y.Z`, and moves the Helm chart's `appVersion` and the desktop
   Cargo package/lockfile to the same version. Tauri reads its version directly from the root
   `package.json`.
4. Merge it. That is the publish.

Merging is the trigger, so a release is always a reviewed commit: on `main` for a stable release,
and on `release/X.Y` for a candidate, beta or final.

`kind` chooses what the run releases: `stable` (the default), `rc`, `beta` or `final`. A plain
`patch`, `minor` or `major` from `main` is a `stable` release and works as described above. The
other three are for a release candidate or beta, and are described under
[Release candidates and betas](#release-candidates-and-betas) and
[Finishing a candidate](#finishing-a-candidate).

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
and are not Apple-notarized. See [Windows signing](windows-signing.md) for signed NSIS builds.

## Which Intelligence CLI an installer carries

The desktop installer bundles the Intelligence CLI and the Node runtime that runs it.
`desktop/intelligence-cli.json` chooses both:

```json
{ "cli": "latest", "node": "25.9.0" }
```

`cli` is one of:

- the `copilotkit` npm dist-tag `latest`, which is the default
- any other npm version or dist-tag of `copilotkit`, such as `1.2.3` or `next`
- a `https://pkg.pr.new/...` preview URL, such as
  `https://pkg.pr.new/CopilotKit/Intelligence/copilotkit-pr@<sha>`

Any other URL is refused. `node` is an exact Node version. The download is checked against the
SHA-256 that nodejs.org lists in `SHASUMS256.txt`, and a mismatch fails the build.

A version or URL that does not exist fails the build, because `npm pack` cannot fetch it. So does a
package that does not ship `index.js` as its bin. Nothing falls back to a different CLI.

The build records what it actually bundled in `build-version.json`: the CLI's source, package name,
exact version and integrity hash, and Node's exact version and SHA-256. A `latest` or a preview URL
is therefore readable afterwards as the version it turned into.

Cutting a release candidate or beta pins `cli` to an exact version when it names an npm dist-tag,
whether `latest`, `next` or another. The tag is replaced with the version it resolves to at that
moment. An exact version and a `https://pkg.pr.new/...` URL are left as they are, because neither
can move. So the candidate and the release built from it carry the same CLI. A final release cannot
change the file. The pin stays on the release branch: the merge-back PR keeps main's own choice, as
described under [Finishing a candidate](#finishing-a-candidate).

To assemble the bundle locally, from the repository root:

```sh
bun desktop/scripts/cli-bundle.ts darwin arm64
```

The platform is `darwin` or `win32`, and the architecture is `arm64` or `x64`. The bundle is written
to `desktop/src-tauri/cli-bundle`.

On a tree without `desktop/src-tauri/tauri.bundled-cli.conf.json`, which is `main` today, CI
bundles nothing and the installer carries no CLI.

## Internal builds

An internal build is an installer for the team to try, made from any branch. Nothing is published:
no release, no tag, and nothing on the Releases page.

Run **Internal build** from the Actions tab and choose the branch. Once the workflow is on the
default branch, the same run starts from a terminal:

```sh
gh workflow run internal-build.yml --ref my-branch
```

The run builds the images for that commit, then a Mac (Apple Silicon) installer and a Windows (x64)
installer. The images are pushed tagged `sha-<commit>` and never `latest`, so the release images
stay where they are.

Each installer is pinned to what the run built:

- its deployment version is `internal-<sha12>`, the first twelve characters of the commit
- its images are the `sha-<commit>` images of that commit, by digest

A pinned installer never asks for `releases/latest`. Opening it installs that exact build, and it
replaces whatever deployment is installed on the machine, keeping its data. OpenBot's database does
not migrate backwards, so switching to a build with older migrations is the tester's risk.

The installers are run artifacts, kept 30 days. Share them by linking to them from the run
summary, which lists one link per installer. The summary names the commit and the manifest version,
and each installer's own section there names its CLI and Node versions. Mac builds are ad-hoc signed
and Windows builds are unsigned, so the first open needs an exception on both. On a Mac, use the
exception described under [Desktop build versions](#desktop-build-versions). On Windows, SmartScreen
warns about an unknown publisher: choose **More info**, then **Run anyway**. For a signed Windows
build, see [Windows signing](windows-signing.md).

A CLI is bundled only on a tree that has `desktop/src-tauri/tauri.bundled-cli.conf.json`. On a
branch without it the installer carries no CLI, and the summary says "no CLI bundled".

Opening a customer installer afterwards moves the deployment to the latest release, keeping its
data. A customer build leaves a deployment alone only when that deployment was not pinned.

## Release candidates and betas

A release candidate or beta is a version people can try before it is the release. It is published
where testers can find it, and nowhere that would hand it to everybody else.

Run **Create release PR** with `kind` set to `rc` or `beta`. `bump` matters only for the first one,
because it chooses the version the candidate is heading for. After that the version keeps counting,
so `0.3.0-rc.1` is followed by `0.3.0-rc.2`.

The first run, started from `main`, cuts the branch `release/X.Y` and opens a release PR into it.
`from` is optional and only applies to this first run. It names the commit on `main` to cut from, as
a full commit SHA or a branch name, and the default is the tip of `main`. A short SHA does not work.
The run refuses a commit that is not on `main`.

Every later candidate runs from `release/X.Y`, by choosing that branch in **Use workflow from**. A
second run from `main` is refused, because the branch already exists. A `from` on a later run is
refused too.

A fix goes onto `release/X.Y` through its own pull request, and then becomes the next candidate.
Merging the release PR is the publish, the same as for a release from `main`. The publish workflow
also runs on pushes to `release/**`, and decides from the merged pull request that a push is a
candidate, as it does for `main`. A stable release is never cut from a release branch.

Each candidate or beta is published as a GitHub prerelease. It is never Latest, so customers who
check for the latest release do not see it. Its images are tagged with the version and
`sha-<commit>`, and never `latest`. A Mac (Apple Silicon) and a Windows (x64) installer are attached
to it, pinned to that version and to those images, the same as an internal build is. The Mac one is
ad-hoc signed and the Windows one is unsigned, so the first open needs the exceptions described
under [Internal builds](#internal-builds).

A candidate does not promote the changelog. Its notes are what is under `## Unreleased` at that
moment, and the final promotes them. A candidate also fixes the CLI choice, as described under
[Which Intelligence CLI an installer carries](#which-intelligence-cli-an-installer-carries).

## Finishing a candidate

Run **Create release PR** with `kind` set to `final`, from `release/X.Y`. A final started from
`main` is refused, with a message telling you to run it from the release branch. `bump` has no
effect, because the version is the candidate's version without its suffix.

The tip of `release/X.Y` must carry a candidate tag. If the branch has moved on since its last
candidate, the run stops with "Cut a new candidate first". A final ships what a candidate was
tested as, so it is cut from the commit a candidate was published from and nothing newer.

The final release PR promotes the changelog and moves the same version files as any release. When
it merges, the publish workflow compares the release against its candidate before it builds
anything, and fails if anything else changed. The allowed difference is:

- the `version` in `package.json`
- `CHANGELOG.md`
- `appVersion` in `charts/openbot/Chart.yaml`
- the `openbot-desktop` version in `desktop/src-tauri/Cargo.toml` and `Cargo.lock`

A final also cannot change `desktop/intelligence-cli.json`, so it bundles the CLI the candidate
pinned.

The final is a normal release: its installers are attached, and it becomes Latest, with its images
tagged `latest`, only when no newer release already is. A patch from `main` can be released while a
newer final is out, and that does not move Latest back.

The smoke journey is still required before a final. See
[The one thing CI cannot do](#the-one-thing-ci-cannot-do). The PR body asks for the result, as it
does for any stable release.

Afterwards the publish workflow opens a PR titled "Merge release/X.Y back into main". The version,
the changelog section and every fix made on the release branch exist only there until it merges.

The PR comes from `merge-back/vX.Y.Z`, not from `release/X.Y`. The workflow makes that branch at the
tip of `release/X.Y`, and puts main's `desktop/intelligence-cli.json` back on it when the two
differ. The candidate pinned the CLI to an exact version for the release only, so main keeps its
own choice, such as `latest`. A push to `merge-back/vX.Y.Z` is not a release.

A PR opened by a workflow does not start CI, so push an empty commit to `merge-back/vX.Y.Z` or close
and reopen the PR before merging. If the merge conflicts, a person resolves it.

## What merging does

`publish-release.yml` runs on every push to `main` and to `release/**`, and starts by deciding
whether the commit is a release at all. It asks the API for the pull request that produced the
commit, and requires that the head branch matches `release/publish/vX.Y.Z`, with a `-rc.N` or
`-beta.N` suffix for a candidate or beta, that the branch is in this repository, and that the pull
request carries the `release` label. A fork can name a branch anything; it cannot add a label.

A version without a suffix merges into `main`, as a `stable` release, or into `release/X.Y`, as a
final. A candidate or beta merges only into the `release/X.Y` its version names. A labelled release
PR merged anywhere else fails the run. Cutting a plain `patch`, `minor` or `major` from `main` is
unchanged. What it publishes now also includes the installers and the `sha-<commit>` image tag, as
listed below.

Then, in order:

- the version in the tree is checked against the branch that is publishing it, and the changelog is
  checked for a section with that number
- one image is built and pushed to `ghcr.io/copilotkit/openbot`, tagged with the version, the
  commit as `sha-<commit>` and `latest` only when the release becomes Latest (a stable release with
  no newer release already out). A candidate or beta is never tagged `latest`
- the services `docker-compose.yml` can build are published too, one image each, at
  `ghcr.io/copilotkit/openbot-<service>`. Those are `linux/amd64` and `linux/arm64`, built on native
  runners of each architecture and joined into one manifest list, because the machines pulling them
  are laptops as well as servers. `.github/published-images.json` is the list, and CI fails if it
  stops matching the Dockerfiles in the tree
- a build provenance attestation is signed with the workflow's OIDC identity and pushed alongside
  every one of them
- the macOS and Windows installers are built from the commit, with the CLI bundled when the tree has
  `desktop/src-tauri/tauri.bundled-cli.conf.json`. A candidate or beta pins the images above; a
  stable release does not
- the commit is tagged and a GitHub Release is created, carrying the changelog section as its notes
  (for a candidate or beta, what is under `## Unreleased`), `container-images.json` and the
  installers as assets. A candidate or beta is marked as a prerelease and never Latest. A stable
  release becomes Latest only when no newer release already is
- for a final cut from `release/X.Y`, the merge-back PR opens as described under
  [Finishing a candidate](#finishing-a-candidate)

The installers attached to a release are ad-hoc signed on Mac and unsigned on Windows, like every
ordinary CI build. Releases do not go through [Windows signing](windows-signing.md) yet.

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

**No secrets are required to release.** CI and **Create release PR** use only the built-in
`GITHUB_TOKEN`. **Publish release**, **Internal build** and the desktop build workflows also pass
`OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET` to the installer build when it is set, and build without
it when it is not.

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
