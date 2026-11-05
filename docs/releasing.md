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

Do not push a `v*` tag by hand to release. A tag pushed by a person builds nothing and publishes
nothing. It only starts [Desktop macOS signing](#signed-mac-builds-and-the-updater) for that tag,
which then fails to attach anything because the tag has no release.

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
and packaging. A signing run on a release tag, and the release's own build, use the plain release
version instead. The artifact includes `build-version.json` with the full commit and release version.

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
- every release starts it. After `publish-release.yml` creates the tag and the release, it
  dispatches this workflow on the tag with `signing-mode: developer-id` and `release-tag` set to
  that version. The tag alone would not start it, because GitHub starts no workflow from a push
  made with `GITHUB_TOKEN`; a `workflow_dispatch` is the exception. The run still waits for a
  required reviewer of the `macos-signing` environment to approve it.
- **Actions → Desktop macOS signing → Run workflow** with `signing-mode: developer-id` signs any
  ref and keeps the results as Actions artifacts for 14 days. Set `release-tag` to an existing
  release, e.g. `v0.2.1`, to also attach the `.dmg` files, the updater archives and their `.sig`
  files, and `latest.json` to it. Run it on the release tag (**Use workflow from** → the tag) so
  the build carries the release version. A build of any other version fails before it attaches
  anything. This is how to re-sign a release by hand. It leaves Latest where it is unless
  `make-latest` is set; see [Which release is Latest](#which-release-is-latest).
- a `v*` tag pushed by a person starts it too. That tag is not a release: see
  [Cutting one](#cutting-one).

Each signed `.dmg` is attached twice: under the name Tauri gives it, which replaces the ad-hoc
`.dmg` of the same name, and under its [fixed download name](#download-links). Both are attached
before the release can become Latest.

Signing imports the certificate into a temporary keychain made for the run, and always deletes
that keychain afterwards, even when an earlier step failed.

A release is signed as the same product its ad-hoc installer was.
[`desktop/scripts/signed-build.ts`](../desktop/scripts/signed-build.ts) builds the signed app:

- a candidate or beta is pinned to its release's own `container-images.json`, as its ad-hoc
  installer is, and refuses one built from another commit. It has no updater, so it makes no
  updater archive and no `latest.json`, and the updater key never reaches its build;
- a stable release is not pinned, and carries the updater;
- either bundles the Intelligence CLI whenever the tree has `tauri.bundled-cli.conf.json`.

Only the signing job produces updater artifacts. `bundle.createUpdaterArtifacts` lives in
`desktop/src-tauri/tauri.macos-signing.conf.json`, which that job alone passes to Tauri, because
Tauri refuses to finish any bundle that asks for updater artifacts without
`TAURI_SIGNING_PRIVATE_KEY`. In the base config it would break ordinary desktop CI and the local
build above. Do not rename the overlay `tauri.macos.conf.json`: Tauri merges that filename into
every Mac build automatically.

The overlay also holds the updater itself, `plugins.updater` with its endpoint and public key.
The app registers the updater plugin only when its config has that block, so desktop CI, local
builds and the unsigned release installers have no updater. They never offer an update and never
show an update error, because they could not verify one.

### The updater

A signed app checks `https://github.com/CopilotKit/OpenBot/releases/latest/download/latest.json`
once at launch. If a newer version is listed, the window offers **Update and restart**. Nothing
installs without that click. GitHub redirects that address to the `latest.json` attached to the
release marked Latest, so the newest non-draft, non-prerelease release is always the one offered.

After it attaches `latest.json`, and marks the release Latest when it should (see below), the
signing workflow fetches that address the way the app does, following redirects, and fails unless
the answer is JSON whose `version` is the release version and which has a `darwin-*` platform with
a URL and signature. A release that is not Latest is not checked, because the apps never read its
feed: a candidate, a patch to an older line, or a release signed again by hand.

### Which release is Latest

`releases/latest`, the download links under it and the update feed all follow the release marked
Latest. A stable release is published **not** Latest, and becomes Latest only once both signing
runs have attached their signed installers: Desktop macOS signing its `.dmg` files and `latest.json`,
and Desktop Windows signing its `-setup.exe`, each under its fixed download name too. Whichever
finishes second marks it ([`scripts/release-make-latest.sh`](../scripts/release-make-latest.sh)).
The two attach jobs share the concurrency group `release-attach-<tag>`, so they run one after the
other and the second always sees what the first attached.
Until then the previous release stays Latest, with its signed installers, so `releases/latest` never
serves an unsigned Windows installer, or an ad-hoc installer that
macOS refuses, or a release with no Intel installer.

Whether a release becomes Latest is decided once, in `verify`, by
[`scripts/release-becomes-latest.sh`](../scripts/release-becomes-latest.sh): never for a candidate or
beta, and for a stable release only when no newer release is Latest. The publish workflow hands
that decision to both signing runs as `make-latest`, and the run that marks the release asks the
script again just before it does, so a newer release published meanwhile keeps Latest. A re-run of
the publish workflow does not touch Latest.

On a stable release only the signing runs attach the fixed download names, so a fixed name on it
means its installer is signed. The release becomes Latest once `latest.json` and every fixed name
are on it.

Making a release Latest also starts **Downloads sync**, so
[downloads.copilotkit.ai](#downloadscopilotkitai) serves the same signed installers. Both attach jobs
have `actions: write` for that.

If either signing run is never approved, or fails, the release stays not Latest. Sign it again from
its tag with `make-latest` set, or mark it Latest by hand on its release page.

`latest.json` names a version and, for `darwin-aarch64` and `darwin-x86_64`, an archive URL and
that archive's minisign signature. The app verifies the signature against the public key in
`plugins.updater.pubkey` in `tauri.macos-signing.conf.json` and refuses any archive that does not
match. That key pair is the Tauri updater key. It is not the Developer ID certificate, and it is
not the Windows Key Vault certificate. Losing the private key means installed apps can never update
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
`desktop/src-tauri/tauri.macos-signing.conf.json`. The signing job refuses to run while that field
still holds `REPLACE_WITH_UPDATER_PUBKEY`.

## Which Intelligence CLI an installer carries

The desktop installer bundles the Intelligence CLI and the Node runtime that runs it.
`desktop/intelligence-cli.json` chooses both:

```json
{
  "cli": "latest",
  "node": {
    "version": "26.13.0",
    "sha256": {
      "darwin-arm64": "d38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6",
      "win32-x64": "14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5"
    }
  }
}
```

`cli` is one of:

- the `copilotkit` npm dist-tag `latest`, which is the default
- any other npm version or dist-tag of `copilotkit`, such as `1.2.3` or `next`
- a pkg.pr.new preview of one Intelligence commit:
  `https://pkg.pr.new/CopilotKit/Intelligence/<package>@<commit>`, where `<package>` is
  `copilotkit`, `copilotkit-pr` or `copilotkit-push` and `<commit>` is 7 to 40 lowercase hex
  characters, such as `https://pkg.pr.new/CopilotKit/Intelligence/copilotkit-pr@4dd2119`

pkg.pr.new also serves a preview by PR number (`copilotkit-pr@123`) or by branch
(`copilotkit-pr@main`), and the bot comment on a PR links the PR-number form. Those move with every
push, so they are refused: copy the commit form instead. Any other URL is refused too.

`node` is the Node runtime: an exact version, which is the current LTS (Node 26), and the SHA-256
of its download for each platform the installers are built for. The download must match both the
pinned SHA-256 and the one nodejs.org lists in `SHASUMS256.txt`. Any difference fails the build, and
so does a platform with no pinned SHA-256. Because the pin is reviewed here, a nodejs.org that
served a different binary with a matching `SHASUMS256.txt` would still be refused.

To move to another Node version, change `version`, open
`https://nodejs.org/dist/v<version>/SHASUMS256.txt`, and copy the hashes on two of its lines:
`node-v<version>-darwin-arm64.tar.gz` for `darwin-arm64`, and `win-x64/node.exe` for `win32-x64`.

A version or URL that does not exist fails the build, because `npm pack` cannot fetch it. So does a
package that does not ship `index.js` as its bin. Nothing falls back to a different CLI.

The build records what it actually bundled in `build-version.json`: the CLI's source, package name,
exact version and integrity hash, and Node's exact version and SHA-256. A `latest` or a preview URL
is therefore readable afterwards as the version it turned into.

The CLI ships no lockfile, so `npm install` picks its dependencies when the installer is built, and
two builds of the same choice can carry different dependency versions. The `package-lock.json` that
npm writes stays in the bundled `cli/` folder, and `build-version.json` records its SHA-256 as
`lockfileSha256` and the number of packages installed from it as `dependencies`. Two builds with the
same `lockfileSha256` carry the same dependency tree.

Cutting a release candidate or beta pins `cli` to an exact version when it names an npm dist-tag,
whether `latest`, `next` or another. The tag is replaced with the version it resolves to at that
moment. An exact version and a pkg.pr.new URL are left as they are: a version cannot move, and the
only pkg.pr.new URL a build accepts names a commit. So the candidate and the release built from it
carry the same CLI. A final release cannot change the file. The pin stays on the release branch: the
merge-back PR keeps main's own choice, as described under
[Finishing a candidate](#finishing-a-candidate).

To assemble the bundle locally, from the repository root:

```sh
bun desktop/scripts/cli-bundle.ts darwin arm64
```

The platform is `darwin` or `win32`, and the architecture is `arm64` or `x64`. The bundle is written
to `desktop/src-tauri/cli-bundle`.

On a tree without `desktop/src-tauri/tauri.bundled-cli.conf.json`, which is `main` today, CI
bundles nothing and the installer carries no CLI.

## Internal builds

For the step-by-step procedure, with what to check at each step, see the
[installer runbook](installer-runbook.md).

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
ad-hoc signed until [Mac signing](#signed-mac-builds-and-the-updater) is approved and replaces it
with a signed one, pinned the same way. Mac signing also adds the Intel installer. The Windows one
is unsigned until [Windows signing](windows-signing.md) is approved and replaces it with a signed
one, pinned the same way. Until then the first open needs the exceptions described under
[Internal builds](#internal-builds). Link a candidate's installers by its version, as described
under [Download links](#download-links).

A candidate does not promote the changelog. Its notes are what is under `## Unreleased` at that
moment, and the final promotes them. A candidate also fixes the CLI choice, as described under
[Which Intelligence CLI an installer carries](#which-intelligence-cli-an-installer-carries).

`release-policy.json` describes one release: the versions it upgrades from, its database transition,
downtime and recovery, and the version it was written for. Publishing refuses a policy that names
another version. Its candidates, betas and final share it, so **Create release PR** moves its
`version` along within one release, `v0.3.0` to `v0.3.0-rc.1` to `v0.3.0`, and changes nothing
else. A policy written for an earlier release is left alone: write the new release's policy into
the release PR before merging it. A final may not change the policy beyond its version.

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
tagged `latest`, only when no newer release already is, and only once its signed Mac and Windows
installers are attached (see [Which release is Latest](#which-release-is-latest)). A patch from `main` can be
released while a newer final is out, and that does not move Latest back.

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

Merge the merge-back PR with a merge commit, not a squash, so main keeps the release branch's
history and the next merge-back does not conflict.

## Download links

Every release carries each installer twice: under the name Tauri gives it, which contains the
version, and under a fixed name that is the same in every release. A web page links to the fixed
name. On a candidate or beta the publish workflow attaches both. On a stable release it attaches the
unsigned installers under their versioned names only, and the signing runs attach the fixed names
from the signed installers:

| Platform | Address |
|---|---|
| Mac, Apple silicon | `https://github.com/CopilotKit/OpenBot/releases/latest/download/OpenBot-mac-arm64.dmg` |
| Mac, Intel | `https://github.com/CopilotKit/OpenBot/releases/latest/download/OpenBot-mac-x64.dmg` |
| Windows, x64 | `https://github.com/CopilotKit/OpenBot/releases/latest/download/OpenBot-windows-x64-setup.exe` |

These names are a public address. Do not change them: every page that links to one breaks.
[`scripts/release-download-names.sh`](../scripts/release-download-names.sh) maps the Tauri names to
them, and the publish and signing workflows fail on an installer it does not know.

`releases/latest/download` goes to the release marked Latest. A candidate or beta is never Latest,
so these addresses never give one. Link a prerelease by its version instead, for example
`https://github.com/CopilotKit/OpenBot/releases/download/v0.3.0-rc.1/OpenBot-mac-arm64.dmg`.

A stable release becomes Latest only once both signing runs have attached their signed installers
under both names (see [Which release is Latest](#which-release-is-latest)), so these addresses
always give signed builds, and the Intel one always exists. Until then they give the previous
release's. Each signing run replaces its installers under both names, and running it again replaces
them again.

A re-run of the publish workflow keeps an installer that is already attached, signed or not. On a
candidate or beta it makes the fixed-name copy from it, replacing a copy that is missing or differs;
on a stable release it leaves the fixed names to the signing runs. So a re-run never puts an
unsigned build back over a signed one, under either name. To replace an attached installer with a
new build, delete it from the release first, then re-run.

Linux installers are not attached to a release yet.

### downloads.copilotkit.ai

The website links to `downloads.copilotkit.ai`, which serves a copy of the Latest stable release's
signed installers:

| Platform | Address |
|---|---|
| Mac, Apple silicon | `https://downloads.copilotkit.ai/latest/OpenBot-mac-arm64.dmg` |
| Mac, Intel | `https://downloads.copilotkit.ai/latest/OpenBot-mac-x64.dmg` |
| Windows, x64 | `https://downloads.copilotkit.ai/latest/OpenBot-windows-x64-setup.exe` |
| Update feed | `https://downloads.copilotkit.ai/latest/latest.json` |

Each stable release's installers also stay under their versioned names, for example
`https://downloads.copilotkit.ai/releases/v0.3.0/OpenBot_0.3.0_aarch64.dmg`. Those never change, so
they are cached for a year; the `latest/` addresses are cached for five minutes. The installed apps
still read their update feed from GitHub.

**Downloads sync** ([`downloads-sync.yml`](../.github/workflows/downloads-sync.yml), running
[`scripts/downloads-sync.sh`](../scripts/downloads-sync.sh)) keeps it in step. The signing run that
makes a stable release Latest starts it ([`scripts/release-make-latest.sh`](../scripts/release-make-latest.sh)),
so the addresses follow within minutes; it also runs every six hours in case anything drifted, and
by hand. Each run:

- reads the release GitHub marks Latest, which is never a candidate, a beta or a draft;
- checks it carries `latest.json` and every installer under its fixed download name, and that each
  versioned installer is the same file as its fixed-name copy, so both are the signed build;
- compares each file's SHA-256 with what the bucket holds, uploads only what differs, and
  invalidates `/latest/*` only when something under `latest/` changed.

When the Latest release lacks some of those files, the run fails and changes nothing, so the
addresses keep serving the previous signed installers. A Latest release with none of them was
published before signing attached any, as v0.2.0 was: that is not drift, so the run succeeds with
"no signed installers yet; nothing to sync" and does not touch AWS. A release asked for by tag must
have them all. Nothing is ever deleted.

To run it by hand, from `main`:

```sh
gh workflow run downloads-sync.yml --ref main              # the Latest release
gh workflow run downloads-sync.yml --ref main -f tag=v0.3.0  # releases/v0.3.0/ only
```

Behind the address, in AWS account `604598162673`: a private, versioned S3 bucket
`copilotkit-openbot-downloads` (us-east-1), read only by CloudFront distribution `EQ4EH8L79LPGX`
through an origin access control, with an ACM certificate for `downloads.copilotkit.ai` and alias
records in the `copilotkit.ai` zone. The workflow signs in as the role `openbot-release-downloads`
with GitHub's OIDC token, so there is no stored key. The role trusts only `downloads-sync.yml` on
`main`, and may only read and write the bucket's objects and invalidate that distribution. The role
ARN, bucket and distribution are written in the workflow; none is a secret.

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
  (for a candidate or beta, what is under `## Unreleased`), `container-images.json`, the source
  archive, the chart, the release manifest and the installers as assets. A candidate or beta is
  marked as a prerelease and never Latest. A stable release is published not Latest. A re-run keeps
  any installer already on the release, so it never puts an unsigned installer back over a signed
  one
- a candidate or beta's installers are also attached under their
  [fixed download names](#download-links). A stable release's fixed names come from the signing runs
- [Desktop macOS signing](#signed-mac-builds-and-the-updater) is dispatched on the tag. It waits
  for a `macos-signing` reviewer, then attaches the signed `.dmg` files to the release. The signed
  `.dmg` has the same name as the ad-hoc one and replaces it, under both names. For a stable release
  it also attaches the updater archives and `latest.json`, and then marks the release Latest when
  `verify` decided it becomes Latest and Windows signing has already attached its installer (see
  [Which release is Latest](#which-release-is-latest)). A
  candidate or beta's signed `.dmg` is pinned to its images, and has no updater archive and no
  `latest.json`
- [Desktop Windows signing](windows-signing.md) is dispatched on the tag. It waits for a
  `windows-signing` reviewer, then attaches the signed `-setup.exe`, which replaces the unsigned one
  under both names. A candidate or beta's is pinned to its images. For a stable release it marks the
  release Latest when `verify` decided it becomes Latest and Mac signing has already attached its
  installers
- for a final cut from `release/X.Y`, the merge-back PR opens as described under
  [Finishing a candidate](#finishing-a-candidate)

Until signing is approved, the Mac installer attached to a release is ad-hoc signed and the
Windows installer is unsigned, like every ordinary CI build, and a stable release is not yet Latest.

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
it when it is not. Signed desktop builds are the exception: they read the `macos-signing` and
`windows-signing` environments described above and in [Windows signing](windows-signing.md).
Downloads sync signs in to AWS with GitHub's OIDC token rather than a stored key.

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
