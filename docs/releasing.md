# Releasing

A release is one person choosing a version, and a reviewed pull request doing everything else. No
step involves a terminal, a tag pushed by hand, or an image built on somebody's laptop.

## Cutting one

1. Before cutting, [rebuild the changelog from the code](#rebuild-the-changelog-from-the-code).
2. Check `## Unreleased` in [CHANGELOG.md](../CHANGELOG.md) reads the way you want it to. It is the
   release notes. Nothing is generated from commit subjects, because a commit subject is written for
   the person reading the diff and these notes are for the person deciding whether to upgrade.
3. Run **Create release PR** from the Actions tab, choosing `patch`, `minor` or `major`. Leave
   `kind` as `stable`. Use `dry_run` first if you want to see the version and the notes without
   opening anything.
4. Review the pull request it opens. It updates `package.json`, promotes the changelog's
   `## Unreleased` heading to `## X.Y.Z`, and moves the Helm chart's `appVersion` and the desktop
   Cargo package/lockfile to the same version. Tauri reads its version directly from the root
   `package.json`.
5. Merge it. That is the publish.

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

### Rebuild the changelog from the code

Entries added to `## Unreleased` since the last release are claims, not evidence, so none is
trusted as written. Before cutting a release, and before the first candidate or beta of one, go
through every change since the last release tag (`git log vX.Y.Z..origin/main` and each one's diff),
check it in the code, and write `## Unreleased` from what the code shows: keep an entry only where
the code proves it, rewrite one that overstates, understates or misdescribes the change, drop one
the code does not do, and add one for any change no entry mentions. Land it on `main` as a pull
request like any other.

## Desktop build versions

The root `package.json` is the release version source. CI rejects drift in the desktop Cargo
manifest or lockfile. The release workflow updates those files automatically; after a manual
root version change, run `bun desktop/scripts/desktop-version.ts sync`.

Internal desktop artifacts are numbered after the release the root `package.json` names, which is
the last one published. After the release `X.Y.Z` they use `X.Y.(Z+1)-internal.<commits>.g<commit>`,
for example `0.3.4-internal.863.gb5d03d1f4e43` after 0.3.3, so testers can identify the source
revision. After a candidate or beta, `X.Y.Z-rc.N`, they use `X.Y.Z-rc.N.internal.<commits>.g<commit>`.

The Windows installer and the app compare versions by
[semver precedence](https://semver.org/#spec-item-11), with the same `semver` crate. A prerelease
orders before its own release, so an internal build named `0.3.3-internal.…`, built after 0.3.3 was
released, read as older than 0.3.3, and the installer said a newer version was already installed and
chose **Uninstall before installing**. As a prerelease of the next patch, an internal build orders
after the release it was built from and before the next release, whether that is `X.Y.(Z+1)` or a
minor or major one, so the next release still installs over it as an upgrade. A candidate's internal
build orders after `rc.N` and before `rc.(N+1)`. The release PR's own build is the one exception: its
`package.json` already names the release it is about to publish, so its build is numbered after it.

`<commits>` is the number of commits in the build's history. Semver compares a number as a number
and the hash as text, so the count is what orders a later build after an earlier one; without it,
the Windows installer took a newer internal build for an older one. Counting needs the whole history,
so the workflows that prepare this version check out with `fetch-depth: 0`, and
`desktop-version.ts internal` refuses a shallow checkout.

The in-app updater never offers anything to an internal build, whatever the feed holds: an internal
build can be made from any branch, so no release is sure to contain what it runs. A tester moves on by
installing the next internal build, or a release, by hand.

Both desktop CI and protected Windows signing prepare this version before compilation and
packaging. A signing run on a release tag, and the release's own build, use the plain release
version instead. The artifact includes `build-version.json` with the full commit and release version.

To build locally, from the repository root:

```sh
bun desktop/scripts/desktop-version.ts internal
cd desktop
APPLE_SIGNING_IDENTITY=- bun run tauri build --config src-tauri/tauri.build-version.conf.json --bundles dmg
```

Use `release` instead of `internal` to prepare the plain release version. This only builds an
artifact; it does not publish a release. macOS keeps numeric system version fields
(`CFBundleShortVersionString` and `CFBundleVersion`) and stores the full internal identifier in
`OpenBotBuildVersion` inside the app's `Info.plist`. Windows retains the full identifier in
`ProductVersion` and `FileVersion`; Tauri fills its fixed numeric fields from the same version's
`major.minor.patch`, with `0` for the fourth part. Both platforms' numbers are the build version's
`major.minor.patch`: `0.3.4` (Windows `0.3.4.0`) for an internal build after 0.3.3, the same as the
0.3.4 release, so neither goes backwards from one build to the next. The protected signing job checks
both embedded string versions.

Ad-hoc signed Mac builds require the first-open exception described in
[Apple's instructions](https://support.apple.com/en-us/102445). They are for internal testing
and are not Apple-notarized. See [signed Mac builds](#signed-mac-builds-and-the-updater) for the
ones people install, and [Windows signing](windows-signing.md) for signed NSIS builds.

## Signed Mac builds and the updater

[Desktop macOS signing](../.github/workflows/desktop-macos-signing.yml) builds OpenBot with the
Developer ID certificate, notarizes and staples both the `.app` and the `.dmg`, and produces the
archive the in-app updater installs. It builds both architectures on the Apple silicon runner
(`macos-15`), one job each, the Intel one for the Rust target `x86_64-apple-darwin` as
[Tauri documents](https://v2.tauri.app/distribute/pipelines/github/). The Intel runner it used
before took 22 minutes for what `macos-15` builds in 12. It fails unless each build passes all three
of:

```sh
codesign --verify --deep --strict --verbose=2 OpenBot.app
spctl -a -t exec -vv OpenBot.app
xcrun stapler validate OpenBot.app
```

An ad-hoc build fails every one of them, which is why it needs "Open Anyway".

Each build also has to be its own architecture all the way down.
[`desktop/scripts/verify-mac-arch.sh`](../desktop/scripts/verify-mac-arch.sh) runs `lipo -archs` on
every Mach-O file in the app and in the app inside the `.dmg`: the app itself, its frameworks, the
bundled Node and every native module of the Intelligence CLI. Each must carry the job's
architecture. The one exception is a package that ships a copy per architecture and picks one at run
time, such as `@azure/msal-node-runtime`'s `dist/macos/arm64/` beside `dist/macos/x64/`: the other
architecture's copy is accepted when this one's is beside it. On the Intel build it also starts the
bundled Node under Rosetta once, to show it runs.

When it runs:

- pull requests and pushes to `main` that touch the desktop run only **Updater regressions
  (no Apple access)**. It holds no secrets.
- every release starts it. As soon as `publish-release.yml` has created the tag and the release,
  right after the images, it dispatches this workflow on the tag with `signing-mode: developer-id`
  and `release-tag` set to that version, so signing builds while the rest of the publish run
  finishes. The tag alone would not start it, because GitHub starts no workflow from a push made
  with `GITHUB_TOKEN`; a `workflow_dispatch` is the exception. The run still waits for a required
  reviewer of the `macos-signing` environment to approve it.
- **Actions → Desktop macOS signing → Run workflow** with `signing-mode: developer-id` signs any
  ref and keeps the results as Actions artifacts for 14 days. Set `release-tag` to an existing
  release, e.g. `v0.2.1`, to also attach the `.dmg` files, the updater archives and their `.sig`
  files, and `latest.json` to it. Run it on the release tag (**Use workflow from** → the tag) so
  the build carries the release version. A build of any other version fails before it attaches
  anything. This is how to re-sign a release by hand. It leaves Latest where it is unless
  `make-latest` is set; see [Which release is Latest](#which-release-is-latest).
- a `v*` tag pushed by a person starts it too. That tag is not a release: see
  [Cutting one](#cutting-one).

Each signed `.dmg` is attached twice: under the name Tauri gives it, replacing a candidate's ad-hoc
`.dmg` of the same name, and under its [fixed download name](#download-links). Both are attached
before the release can become Latest.

Signing imports the certificate into a temporary keychain made for the run, and always deletes
that keychain afterwards, even when an earlier step failed.

[`desktop/scripts/signed-build.ts`](../desktop/scripts/signed-build.ts) builds the signed app, the
same product a candidate's ad-hoc installer is:

- a candidate or beta is pinned to its release's own `container-images.json`, as its ad-hoc
  installer is, and refuses one built from another commit. It has no updater, so it makes no
  updater archive and no `latest.json`, and the updater key never reaches its build;
- a stable release is not pinned, and carries the updater;
- either bundles the Intelligence CLI whenever the tree has `tauri.bundled-cli.conf.json`, its
  dependencies installed for the installer's platform (`npm install --os --cpu`), so the Intel
  app built on the Apple silicon runner gets Intel binaries;
- a Mac build names its Rust target, `x86_64-apple-darwin` or `aarch64-apple-darwin`, and Tauri
  leaves it in `desktop/src-tauri/target/<target>/release/bundle`.

Only the signing job produces Mac updater artifacts. `bundle.createUpdaterArtifacts` lives in
`desktop/src-tauri/tauri.macos-signing.conf.json`, which that job alone passes to Tauri, because
Tauri refuses to finish any bundle that asks for updater artifacts without
`TAURI_SIGNING_PRIVATE_KEY`. In the base config it would break ordinary desktop CI and the local
build above. Do not rename the overlay `tauri.macos.conf.json`: Tauri merges that filename into
every Mac build automatically.

The overlay also holds the updater itself, `plugins.updater` with its endpoints and public key.
The Windows signing overlay, `tauri.windows-signing.conf.json`, holds the same block, with the same
key and endpoints (see [Windows updates](#windows-updates)). The app registers the updater plugin
only when its config has that block, so desktop CI, local builds and the unsigned release installers
have no updater. They never offer an update and never show an update error, because they could not
verify one.

### The updater

A signed app reads `https://downloads.copilotkit.ai/latest/latest.json` at launch and every six
hours while it runs. When that address does not answer, it reads
`https://github.com/CopilotKit/OpenBot/releases/latest/download/latest.json`, the file
[Downloads sync](#downloadscopilotkitai) copies there. Both addresses are `plugins.updater.endpoints`
in `tauri.macos-signing.conf.json` and `tauri.windows-signing.conf.json`, in that order, and the
install reads them the same way, so what the app offers and what it installs come from one file. GitHub redirects its address to the
`latest.json` attached to the release marked Latest, so the newest non-draft, non-prerelease release
is always the one offered.

When the feed lists a newer stable version, OpenBot's own window shows a bar, "OpenBot 0.3.2 is
available.", with **Update and restart** and a close button, and the setup window offers the same.
Nothing installs without that click. Closing either hides both until a newer version comes out,
through reloads and restarts. The click downloads the archive and verifies its signature while
OpenBot keeps running, installs it, stops OpenBot (the local Intelligence keeps running), and
restarts the app; that Start [moves the installation to the app's release](desktop-updates.md#the-deployment-follows-the-app).
On Windows the order differs, because Windows will not replace a running app: once the installer
is downloaded and verified, OpenBot is stopped, the installer runs in update mode with a small
progress window and no questions, and it starts the new version when it is done.
The shell does all of it (`desktop/src-tauri/src/app_update.rs`); neither page reaches the feed or
holds the updater's permissions. A self-hosted OpenBot in a browser has no shell, and never reads
the feed.

To see the bar without a release, build the desktop in debug with `TAURI_CONFIG` set to an overlay
that gives it its own `identifier` and a `plugins.updater` with the real `pubkey`,
`"endpoints": ["http://127.0.0.1:<port>/latest.json"]` and
`"dangerousInsecureTransportProtocol": true`. Serve a `latest.json` there with a newer `version`,
start an OpenBot of your own (server and app), and run the binary with
`OPENBOT_DESKTOP_TEST_APP_URL` set to that app's address: a debug build shows it in its window as
its own OpenBot. Give the run its own `HOME` as well, so nothing it does can reach an installed
OpenBot in `~/OpenBot`. Release builds never read the variable.

To try the background download of an update (`desktop/src-tauri/src/update_ready.rs`) on a test
machine, start an **internal** build with `OPENBOT_TEST_UPDATE_FEED` set to a folder holding a
`latest.json` (only its `version` is read) and the `desktop-images.json` of the build it names. The
build reads that folder as its update feed: it logs `[update ready] using a test feed from <folder>`,
offers the version, and downloads its images in the background. It installs nothing, since an
internal build has no updater: install the next build by hand. A stable or candidate build never
reads the variable.

After it attaches `latest.json`, and marks the release Latest when it should (see below), the
signing workflow fetches the GitHub address the way the app does, following redirects, and fails
unless the answer is JSON whose `version` is the release version and which lists `darwin-aarch64`,
`darwin-x86_64` and `windows-x86_64`, each with a URL and signature. Downloads sync, which that same step starts, then puts a copy of that file,
checked against GitHub's digest, at the downloads address within minutes. A release that is not
Latest is not checked, because the apps never read its feed: a candidate, a patch to an older line,
or a release signed again by hand.

### Which release is Latest

`releases/latest`, the download links under it and the update feed all follow the release marked
Latest. A stable release is published **not** Latest, and becomes Latest only once both signing
runs have attached their signed installers and listed them in `latest.json`: Desktop macOS signing
its `.dmg` files and both Mac archives, and Desktop Windows signing its `-setup.exe`, each under its
fixed download name too. Whichever
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
means its installer is signed. The release becomes Latest once every fixed name is on it and its
`latest.json` lists every platform, so no app is left out of a Latest release's feed.

Making a release Latest also starts **Downloads sync**, so
[downloads.copilotkit.ai](#downloadscopilotkitai) serves the same signed installers. Both attach jobs
have `actions: write` for that.

If either signing run is never approved, or fails, the release stays not Latest. Sign it again from
its tag with `make-latest` set, or mark it Latest by hand on its release page.

`latest.json` names a version and, for `darwin-aarch64` and `darwin-x86_64`, an archive URL and
that archive's minisign signature, and for `windows-x86_64` the signed installer's URL and its
signature. Both signing runs write into the one file
([`scripts/release-update-feed.sh`](../scripts/release-update-feed.sh)): each keeps the platforms the
other already listed for the same version, and their attach jobs never run at once. The app verifies
the signature against the public key in `plugins.updater.pubkey` and refuses any file that does not
match. That key pair is the Tauri updater key. It is not the Developer ID certificate, and it is
not the Windows Key Vault certificate. Losing the private key means installed apps can never update
again, so keep it in 1Password as well as in the environment.

### Windows updates

On Windows the updater installs the NSIS installer itself, so the file a person downloads and the
file the updater installs are the same signed `-setup.exe`. Its updater signature is made after
Authenticode signing, over exactly those bytes, by the **Sign the installer for the updater** job
of [Desktop Windows signing](windows-signing.md#updates). The updater key lives only in the
`macos-signing` environment, so that job runs there: a Windows release run asks for a
`windows-signing` approval to build and sign, then a `macos-signing` approval to sign for the
updater. The job signs with `tauri signer sign`, the same signing `tauri build` does for the Mac
archives, checks the signature against `plugins.updater.pubkey` with minisign, and the attach job
uploads `OpenBot_<version>_x64-setup.exe.sig` and lists the installer in `latest.json`.

The Windows app installs per user, so the update needs no administrator prompt. It runs the
installer in update mode (`installMode: passive`), which never runs the uninstaller: the
installation in `~/OpenBot`, the app's settings and data under `%APPDATA%` and `%LOCALAPPDATA%`, and
the Recorder's registration all stay as they were. Windows apps from
before this have no updater, so each Windows installation updates by hand once, to the first
release that has it.

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
desktop builds do. Desktop Windows signing's **Sign the installer for the updater** job reads the
two `TAURI_SIGNING_*` secrets from this environment too; nothing else outside it holds them.

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
      "darwin-x64": "525c9b29bb0263d687de60a4cec0e2a6db876a8eb032369e5795eca71e7c358e",
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
`https://nodejs.org/dist/v<version>/SHASUMS256.txt`, and copy the hashes on three of its lines:
`node-v<version>-darwin-arm64.tar.gz` for `darwin-arm64`, `node-v<version>-darwin-x64.tar.gz` for
`darwin-x64`, and `win-x64/node.exe` for `win32-x64`.

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
to it, pinned to that version and to those images, the same as an internal build is. They are built
beside the release rather than before it, so the signing runs start as soon as the release and its
`container-images.json` exist, and they are attached when they are built, unless a signed one is
already there. The Mac one is ad-hoc signed until [Mac signing](#signed-mac-builds-and-the-updater)
is approved and replaces it with a signed one, pinned the same way. Mac signing also adds the Intel
installer. The Windows one is unsigned until [Windows signing](windows-signing.md) is approved and
replaces it with a signed one, pinned the same way. Until then the first open needs the exceptions
described under [Internal builds](#internal-builds). Link a candidate's installers by its version,
as described under [Download links](#download-links).

A candidate does not promote the changelog. Its notes are what is under `## Unreleased` at that
moment, and the final promotes them, so
[rebuild the changelog from the code](#rebuild-the-changelog-from-the-code) on `main` before the
first candidate is cut. A candidate also fixes the CLI choice, as described under
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
name. On a candidate or beta the publish workflow attaches both for its ad-hoc and unsigned
installers, and the signing runs replace both with the signed ones. On a stable release the publish
workflow attaches no installer at all: the signing runs attach both names from the signed
installers, which are the only installers a stable release carries:

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

On a candidate or beta, the publish workflow's `installers` job runs while the signing runs may be
attaching, so it never replaces anything
([`scripts/release-attach-installers.sh`](../scripts/release-attach-installers.sh)): it uploads an
installer, and its fixed-name copy, only when the release has no asset of that name, without
`--clobber`, and when a signing run attached that name meanwhile it keeps the signed one. The
fixed-name copy is made from the installer as the release has it, so when the signed one is already
there the copy is signed too. A signing run always attaches with `--clobber`, so whichever runs
first, the signed build is what stays, under both names. A re-run of the publish workflow does the
same: it adds what is missing and keeps everything else, signed or not, so it never puts an unsigned
build back over a signed one. A fixed name left stale by an interrupted signing upload is put right
by running that signing run again. To replace an attached installer with a new build, delete it from
the release first, then re-run.

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
they are cached for a year; the `latest/` addresses are cached for five minutes. Signed apps read
their [update feed](#the-updater) here, and GitHub's copy only when this address does not answer.
This copy of the feed names this address for each update it lists: a platform's `url` that is the
release's own GitHub download of a file the sync put under `releases/<tag>/` (the versioned
installers and the Mac updater archives) becomes `https://downloads.copilotkit.ai/releases/<tag>/<file>`,
and every other byte, each `signature` included, is the release's `latest.json` as the signing runs
wrote it (minisign signs the file, not its URL). The sync checks each of those addresses answers
before it uploads the feed, and fails otherwise. The release's own `latest.json` on GitHub is never
changed.

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

It also copies everything else the Desktop app downloads for that release, so the app can fetch it
all from this address and go to GitHub only when it does not answer
([`scripts/downloads-images.ts`](../scripts/downloads-images.ts), a second step of the same job):

| Key | What | Cache-Control |
|---|---|---|
| `releases/<tag>/container-images.json`, `releases/<tag>/desktop-images.json`, `releases/<tag>/OpenBot-darwin-*.app.tar.gz` | the release's image pins, the list of every image the app may pull for it (which an older app reads to get the release ready before its Update click) and the Mac updater archives (in `downloads-sync.sh`) | a year, immutable |
| `releases/<tag>/<tag>.tar.gz` | the source archive a deployment is laid out from, as `github.com/CopilotKit/OpenBot/archive/refs/tags/<tag>.tar.gz` serves it | a year, immutable |
| `tools/podman/v<version>/<file>`, `tools/compose/v<version>/<file>` | every Podman installer and Compose binary the release's `desktop/src-tauri/src/install.rs` pins, under the upstream file name, checked against those pins | a year, immutable |
| `v2/` | `{}` (`application/json`), so a registry client's first request answers | five minutes |
| `v2/<repo>/manifests/<tag>` | the bytes ghcr.io serves for the tag, typed by their `mediaType`; invalidated whenever it changes | five minutes |
| `v2/<repo>/manifests/sha256:<hex>` | each index, and every manifest it names (every platform and every attestation), byte for byte | a year, immutable |
| `v2/<repo>/blobs/sha256:<hex>` | each config and layer of those (`application/octet-stream`) | a year, immutable |
| `v2/<repo>/referrers/sha256:<hex>` | an empty OCI image index (`application/vnd.oci.image.index.v1+json`) for each of those manifests | five minutes |

The `v2/` tree is a read-only copy of the OCI Distribution API, at ghcr.io's own paths: `<repo>` is
the ghcr.io path unchanged, such as `copilotkit/openbot-server`, so Docker and containerd pull
`downloads.copilotkit.ai/<repo>@<digest>` (or use it as a mirror for `ghcr.io`) exactly as they
pull from ghcr.io. Indexes are copied byte for byte, so every digest stays the same, and whole:
Docker 29's containerd image store fetches every manifest an index names, attestations included,
and asks the referrers API (`/v2/<repo>/referrers/<digest>`) for each, and a 403 for either fails
its pull. The empty referrers index is a valid answer (OCI distribution spec, "Listing Referrers")
that says nothing refers to the manifest. S3 cannot send `Docker-Content-Digest`, and clients do not need
it: they hash what they receive. A key that is not there answers 403, not 404 (CloudFront has no
`ListBucket`), and containerd moves on to its next host, ghcr.io, on any 4xx.

Docker Hub's images are copied the same way under `v2/docker.io/<repo>/`, official images under
`library/` (`v2/docker.io/library/busybox`), so a client uses `downloads.copilotkit.ai/docker.io` as
the mirror for `docker.io`. quay.io's are copied under `v2/quay.io/<repo>/`: the Podman engine machine
images, which the app downloads itself from the first setup screen as plain blobs
(`v2/quay.io/podman/machine-os/blobs/<digest>`, then quay.io), and builds the machine from
(`desktop/src-tauri/src/early_downloads.rs`). Images on any other registry are left where they are.

Which images: every image the release's `container-images.json` pins, all of them, and every image
`desktop-images.json` on the release names. The `image list` job of the publish workflow writes that
list with the app's own code (`desktop/src-tauri/src/release_images.rs`, run as
`cargo run --example release_images`), and `tag and release` waits for it and attaches it with
`container-images.json`, so a release is never published without it: the images Compose names for
every Bot the app can install (`pgvector` included), the two sign-in images, the bundled CLI's back
end images (its runtime images at its release's tag, its pinned ones and the Kubernetes system
images), and the cluster's own images that the host's engine pulls when k3d creates the cluster (the
k3s node image and k3d's proxy and tools, at the digests the CLI gives k3d), and the engine machine
images Podman's machine is built from (`quay.io/podman/machine-os`, by the digests
`early_downloads.rs` pins). A release published
before this carries no list, and only its `container-images.json` images are copied;
`DOWNLOADS_IMAGES_FILE` names a list to use instead. Images
are read with [crane](https://github.com/google/go-containerregistry) (a pinned release, checked by
SHA-256). An image named by digest whose manifest the bucket already holds is not read again, which
keeps the scheduled run inside Docker Hub's pull limits; tags are read on every run.

The images are copied first, before `downloads-sync.sh` writes `latest/`, and the step ends by
asking `https://downloads.copilotkit.ai` for every image's top manifest (`HEAD`, asked again twice
after ten seconds). Any that does not answer 200 fails the job, named, so `latest/` never moves to a
release whose images are not there. To check a release's images by hand, with no AWS credentials:

```sh
GITHUB_REPOSITORY=CopilotKit/OpenBot DOWNLOADS_VERIFY_ONLY=1 bun scripts/downloads-images.ts
GITHUB_REPOSITORY=CopilotKit/OpenBot DOWNLOADS_VERIFY_ONLY=1 DOWNLOADS_TAG=v0.3.4 bun scripts/downloads-images.ts
```
Each object is compared with what S3 holds by SHA-256, Content-Type and Cache-Control, and only what
is missing or differs is read and uploaded: blobs first, then manifests, then tags, so nothing is
served before what it names. Every new object is then fetched once through the address, so the
distribution's Origin Shield (us-east-1) holds it before anyone installs.

To copy the images of a release published before it listed them, generate the list and pass it,
from a checkout with admin credentials for the account:

```sh
git show v0.3.3:docker-compose.yml > /tmp/compose.yml
gh release download v0.3.3 -p container-images.json -O /tmp/container-images.json
npm pack "$(git show v0.3.3:desktop/intelligence-cli.json | jq -r .cli)" --pack-destination /tmp
tar -xzf /tmp/copilotkit-*.tgz -C /tmp package/index.js
cargo run --manifest-path desktop/src-tauri/Cargo.toml --example release_images -- \
  /tmp/compose.yml /tmp/container-images.json /tmp/package/index.js > /tmp/desktop-images.json
GITHUB_REPOSITORY=CopilotKit/OpenBot DOWNLOADS_BUCKET=copilotkit-openbot-downloads \
  DOWNLOADS_DISTRIBUTION_ID=EQ4EH8L79LPGX DOWNLOADS_TAG=v0.3.3 \
  DOWNLOADS_IMAGES_FILE=/tmp/desktop-images.json bun scripts/downloads-images.ts
```

When the Latest release lacks some of those files, the run fails and changes nothing, so the
addresses keep serving the previous signed installers. A Latest release with none of them was
published before signing attached any, as v0.2.0 was: that is not drift, so the run succeeds with
"no signed installers yet; nothing to sync" and does not touch AWS. A release asked for by tag must
have them all. Nothing is ever deleted.

To run it by hand, from `main`:

```sh
gh workflow run downloads-sync.yml --ref main              # the Latest release
gh workflow run downloads-sync.yml --ref main -f tag=v0.3.0  # releases/v0.3.0/ only
gh workflow run downloads-sync.yml --ref main -f tag=v1.0.0-rc.1  # a candidate or beta
```

A candidate or beta is mirrored too, so its installs download from this address: asked for by tag,
its images and its `releases/<tag>/` files (cached for five minutes, since its signing runs may
still replace an installer), and never `latest/`, which stays the Latest stable release's. Each
scheduled or Latest run also copies the images, source archive and pinned tools of every published
prerelease newer than Latest and under 30 days old, so a candidate is covered within six hours of
publishing without anyone dispatching a run. A draft is never mirrored. The publish workflow does
not dispatch the sync for a prerelease: it runs from the release branch's own copy of
`publish-release.yml`, so that would have to land on each release branch; dispatch it by hand to
cover a candidate sooner.

Behind the address, in AWS account `604598162673`: a private, versioned S3 bucket
`copilotkit-openbot-downloads` (us-east-1), read only by CloudFront distribution `EQ4EH8L79LPGX`
through an origin access control, with an ACM certificate for `downloads.copilotkit.ai` and alias
records in the `copilotkit.ai` zone. The distribution is `PriceClass_All` with HTTP/3, IPv6 and
Origin Shield in us-east-1, and uses the managed CachingOptimized policy, which honours each object's
Cache-Control and leaves query strings out of the cache key. All of it is managed by hand in the
console, not by infrastructure as code. The workflow signs in as the role `openbot-release-downloads`
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
- the commit is checked, as described under [What has to be green](#what-has-to-be-green): the full
  CI suite, or, when the release PR changed only the release files on a commit main's CI passed,
  that run and the checks that read the release files
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
- the commit is tagged and a GitHub Release is created, carrying the changelog section as its notes
  (for a candidate or beta, what is under `## Unreleased`), `container-images.json`, the source
  archive, the chart and the release manifest as assets. A candidate or beta is marked as a
  prerelease and never Latest. A stable release is published not Latest, with no installers yet
- [Desktop macOS signing](#signed-mac-builds-and-the-updater) is dispatched on the tag straight
  away. It waits for a `macos-signing` reviewer, then builds both Macs and attaches the signed `.dmg`
  files to the release, under both names. For a stable release it also attaches the updater
  archives and lists them in `latest.json`, and then marks the release Latest when `verify` decided
  it becomes Latest and Windows signing has already attached and listed its installer (see
  [Which release is Latest](#which-release-is-latest)). A candidate or beta's signed `.dmg` is
  pinned to its images, and has no updater archive and no `latest.json`
- [Desktop Windows signing](windows-signing.md) is dispatched on the tag at the same moment. It
  waits for a `windows-signing` reviewer, then attaches the signed `-setup.exe` under both names. A
  candidate or beta's is pinned to its images. For a stable release it then waits for a
  `macos-signing` reviewer to sign the installer for the updater, attaches that signature, lists the
  installer in `latest.json`, and marks the release Latest when `verify` decided it becomes Latest
  and Mac signing has already attached and listed its installers
- for a candidate or beta only, its macOS (Apple silicon) and Windows installers are built from the
  commit while signing runs, ad-hoc signed and unsigned, with the CLI bundled when the tree has
  `desktop/src-tauri/tauri.bundled-cli.conf.json` and pinned to the images above. They are attached
  under both names wherever the release does not already have a signed one (see
  [Download links](#download-links)). A stable release builds none here: the signing runs' builds
  are the only installers it carries, and the Desktop workflow builds and tests the app on the
  release commit's push to `main` anyway
- for a final cut from `release/X.Y`, the merge-back PR opens as described under
  [Finishing a candidate](#finishing-a-candidate)

Until signing is approved, a stable release has no installers and is not Latest, so
`releases/latest` keeps serving the previous release's signed ones. A candidate or beta has its
ad-hoc Mac installer and unsigned Windows installer, like every ordinary CI build, once they are
built.

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

These checks gate the publish rather than the proposal, which is why the release PR arriving
without its own checks does not matter: a pull request opened by a workflow does not trigger them.
When the release PR merges, the publish workflow's `checks needed` job
([`scripts/release-ci-gate.ts`](../scripts/release-ci-gate.ts)) decides whether they run again on the
release commit:

- When the release commit changes nothing but the release files from the commit it merged onto
  (its first parent), and main's CI passed on that commit, they do not. That commit's tree has been
  through all of them already. The release files are `CHANGELOG.md` and `release-policy.json`, which
  may change freely, and the `version` in `package.json`, the `openbot-desktop` version line in
  `desktop/src-tauri/Cargo.toml` and `Cargo.lock` and `appVersion` in `charts/openbot/Chart.yaml`,
  which may change nothing else. Only a run of `ci.yml` for a push to this repository's `main`, at
  exactly that commit, counts; a pull request's run tests a merge of the PR, not the commit, and
  skips `image` unless it was labelled. A run still in progress is waited for, up to 40 minutes. In
  their place the job re-runs the checks that read the files the release did change: formatting and
  lint, the desktop and chart versions against `package.json`, and every test that names
  `CHANGELOG.md` or `release-policy.json`.
- Otherwise they all run again, as before: when any other path is added, removed, renamed or
  changed, when a version file changes more than its version, or when main's CI on that commit
  failed, was cancelled, never ran, could not be read, or was still running after the wait.

The diff is read with renames turned off, so a source file moved onto a release file's name is still
seen as the source file it removed. Every commit on `main` keeps its own CI run for this (the
`concurrency` group in `ci.yml` is per commit on `main`), so a commit pushed while another's run was
in progress still gets a result. A final's parent is its candidate on `release/X.Y`, which main's CI
never ran on, so a final always runs the full suite.

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
