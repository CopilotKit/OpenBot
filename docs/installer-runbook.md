# Installer runbook: build, release, install and check a desktop installer

This is the procedure for making an OpenBot Desktop installer and proving that it works. Follow it
in order. Every step says what you should see. If you see something else, stop and use
[When something goes wrong](#when-something-goes-wrong).

For what the installer does once it runs, read [Desktop install](desktop-install.md). For the full
release reference, read [Releasing](releasing.md).

## Before you start

You need:

- write access to `CopilotKit/OpenBot`, to start workflows;
- the GitHub CLI (`gh`), signed in, for the command-line steps;
- an Apple silicon Mac;
- an x64 Windows 11 PC, or an x64 cloud VM with nested virtualization. A Windows on ARM VM on an
  Apple silicon Mac cannot run WSL 2, so it cannot run OpenBot;
- a CopilotKit account, to sign in during setup;
- an AI provider key, such as an OpenAI or Anthropic key.

Signed builds need an approval. These people can approve:

| Environment | Approvers |
|---|---|
| `macos-signing` (Mac Developer ID signing) | jpr5, davidmckayv |
| `windows-signing` (Windows signing) | davidmckayv, tylerslaton, jpr5, mme, contextablemark |

Internal builds are not signed and need no approval.

## What an installer contains

An installer is made from one commit. It contains:

| Part | Where it comes from | Where it is recorded |
|---|---|---|
| The app | The commit | `build-version.json`: `version`, `sourceSha` |
| The bundled Intelligence CLI | `desktop/intelligence-cli.json` (`cli`) | `build-version.json`: `cli` (name, exact version, integrity, `lockfileSha256`) |
| The bundled Node runtime | `desktop/intelligence-cli.json` (`node`), checked by SHA-256 | `build-version.json`: `node` |
| The deployment and its images (internal builds and candidates only) | The images built from the same commit, tagged `sha-<commit>`, pinned by digest | Compiled into the app; written to `~/OpenBot/.openbot-deployment` and `~/OpenBot/container-images.json` on install |

There are three kinds of build:

| Kind | Made by | Pinned to its commit | Signed | Where it goes |
|---|---|---|---|---|
| Internal build | **Internal build** workflow | Yes | No | Workflow artifacts, kept 30 days |
| Release candidate or beta | **Create release PR**, then merge | Yes | After approval | GitHub prerelease |
| Stable release | **Create release PR**, then merge | No: it installs the latest release | After approval | GitHub release, marked Latest once Mac and Windows signing have both attached their signed installers |

A release is made only by merging its release PR. Do not push a `v*` tag by hand: that builds and
publishes nothing. It only starts Mac signing, which then has no release to attach to.

Every release carries each installer under a fixed name as well as under its versioned name. These
addresses always give the installers of the release marked Latest:

| Platform | Address |
|---|---|
| Mac, Apple silicon | `https://github.com/CopilotKit/OpenBot/releases/latest/download/OpenBot-mac-arm64.dmg` |
| Mac, Intel | `https://github.com/CopilotKit/OpenBot/releases/latest/download/OpenBot-mac-x64.dmg` |
| Windows, x64 | `https://github.com/CopilotKit/OpenBot/releases/latest/download/OpenBot-windows-x64-setup.exe` |

A candidate or beta is never Latest. Link to its installers by version:
`https://github.com/CopilotKit/OpenBot/releases/download/<tag>/OpenBot-mac-arm64.dmg`. See
[Download links](releasing.md#download-links).

## 1. Make an internal build

Use an internal build to test a branch. Nothing is published.

**Condition:** the **Internal build** workflow must be on `main`, and the branch you build must
contain the build workflows (`internal-build.yml`, `images.yml`, `desktop-build.yml`). If the branch
is older than those workflows, merge `main` into it first.

1. Start the build. Either:
   - on GitHub, open **Actions → Internal build → Run workflow**, choose the branch, and select
     **Run workflow**; or
   - from a terminal:

     ```sh
     gh workflow run internal-build.yml -R CopilotKit/OpenBot --ref <branch>
     ```

2. Find the run and watch it:

   ```sh
   gh run list -R CopilotKit/OpenBot --workflow internal-build.yml --limit 1
   gh run watch <run-id> -R CopilotKit/OpenBot --exit-status
   ```

   **Expected:** every job succeeds. The image jobs come first; recent runs took 6 to 15 minutes.
   The Mac and Windows installer jobs follow.

3. Open the run page. The summary names the commit and the manifest version
   (`internal-<first 12 characters of the commit>`), and links the two installers.

4. Download the installers:

   ```sh
   gh run download <run-id> -R CopilotKit/OpenBot -n openbot-desktop-macos -D build-mac
   gh run download <run-id> -R CopilotKit/OpenBot -n openbot-desktop-windows -D build-windows
   ```

   **Expected:** each folder has an installer (`.dmg` or `-setup.exe`) and a `build-version.json`.

5. Check the build. Do [Check a build](#4-check-a-build) before you give the installer to anybody.

### On your own Mac

To try a branch on your own Apple silicon Mac without waiting for the workflow, make the same
build locally:

```sh
git commit ...                      # it builds HEAD, never uncommitted work
desktop/scripts/local-build.sh
```

The script:

1. pushes the branch to origin (never `main`, never forced), because a pinned app downloads its
   deployment from `https://github.com/CopilotKit/OpenBot/archive/<commit>.tar.gz`;
2. starts a registry container, `openbot-local-registry`, on `127.0.0.1:5050`;
3. builds `server`, `supervisor`, `agent-computer` and `agent-claude-sdk` from the commit for
   linux/arm64 and pushes them there;
4. writes `container-images.json` with version `local-<first 12 characters of the commit>`: the
   images it built by their local digest, every other image at the latest release's digest;
5. builds `OpenBot.app` pinned to that manifest, with the bundled CLI, ad-hoc signed.

**Expected:** it ends by printing each stage's time, the manifest, and the app's path under
`~/.openbot-local-build/apps/`. To install it, quit OpenBot and copy the app into `/Applications`.

Set `OPENBOT_LOCAL_IMAGES` to build other images (`OPENBOT_LOCAL_IMAGES="server"`), or to an empty
string to take every image from the release. The other settings are at the top of the script.

A local build is for Docker only. Podman cannot pull from a registry on the Mac's own `127.0.0.1`.
Like any build without the update key, it never checks for a newer version, so it shows no update bar.

## 2. Make a release candidate, then the final release

Use a candidate to test what will become a release. The details are in
[Release candidates and betas](releasing.md#release-candidates-and-betas) and
[Finishing a candidate](releasing.md#finishing-a-candidate).

1. Write the release policy. `release-policy.json` must describe the new release: the versions it
   upgrades from, its database transition, downtime and recovery. Publishing refuses a policy that
   names another version. Within one release, **Create release PR** moves only its `version`
   (`v0.3.0`, `v0.3.0-rc.1`, …).
2. Make sure `CHANGELOG.md` has the release notes under `## Unreleased`.
3. Cut the first candidate from `main`:

   ```sh
   gh workflow run release.yml -R CopilotKit/OpenBot --ref main -f kind=rc -f bump=minor
   ```

   **Expected:** a branch `release/X.Y` and a release PR into it.

4. Review and merge the release PR. Merging publishes the candidate.
   **Expected:** a GitHub prerelease `vX.Y.Z-rc.1` with `container-images.json`, the source
   archive, the chart, the release manifest, and the Mac and Windows installers.
5. Approve **Desktop macOS signing** and **Desktop Windows signing** when they ask. These need a
   `macos-signing` and a `windows-signing` approver. For a stable release, Desktop Windows signing
   asks a second time, for `macos-signing`, once its installer is signed: that job signs the
   installer for the in-app updater with the updater key.
   **Expected:** the signed Apple silicon `.dmg` replaces the ad-hoc one on the release, a signed
   Intel `.dmg` is added, and the signed `-setup.exe` replaces the unsigned one. Each is attached
   under its versioned name and its fixed name. For a candidate all three are pinned to the
   candidate's images, like the unsigned ones. A stable release also gets `latest.json`, listing
   both Mac archives and the Windows installer, and becomes Latest when the second of the two
   signing runs finishes. Until then the fixed addresses keep giving the previous release's signed
   installers.
6. Test the candidate with [Install and test](#3-install-and-test) and
   [Check a build](#4-check-a-build).
7. For a fix, merge it into `release/X.Y`, then run **Create release PR** from that branch with
   `kind=rc` for the next candidate.
8. To finish, run **Create release PR** from `release/X.Y` with `kind=final`, then merge. A final may
   not differ from its last candidate except in the version, the changelog and the policy's
   version. **Expected:** a merge-back PR into `main` opens. The release becomes Latest once you
   approve both signing runs for it and they finish (step 5).

A stable release from `main` (`kind=stable`) follows steps 1 to 5 without a release branch. Its
installers are not pinned: they install the latest release. When it becomes Latest, the fixed
addresses in [What an installer contains](#what-an-installer-contains) give its installers.

## 3. Install and test

Start from a clean machine, or the result proves nothing about a first install.

1. Reset the machine. See [Reset a test machine](#5-reset-a-test-machine).
2. Install:
   - **Mac:** open the `.dmg` and drag OpenBot to Applications. An unsigned (ad-hoc) build is
     blocked on the first open: open **System Settings → Privacy & Security** and select
     **Open Anyway**. A signed build opens normally.
   - **Windows:** run the `-setup.exe`. An unsigned build shows SmartScreen: select
     **More info**, then **Run anyway**.
3. Go through setup: **Install** on the first screen, then **Account → AI → Start**. Install runs while you sign in.
   - Sign in to CopilotKit in the browser and accept the evaluation agreement.
   - Install downloads the images and shows each one with its speed. On Windows, the app may set up
     WSL and ask for one restart; open OpenBot again after the restart.
   - Choose the AI provider and enter the key.

   **Expected:** the window becomes OpenBot.
4. Ask a Bot a question. **Expected:** an answer.
5. Record the time from the first click to the open OpenBot, and anything that went wrong.

Web search and app connections need a Composio key in `~/OpenBot/.env`
(`%USERPROFILE%\OpenBot\.env` on Windows) as `COMPOSIO_API_KEY=...`. Without one, they are
unavailable. That is expected for now.

## 4. Check a build

These checks prove that an installer is the build you meant.

1. **The build record.** In the downloaded folder:

   ```sh
   jq '{version, sourceSha, cli: .cli.version, node: .node.version, lockfile: .cli.lockfileSha256}' build-version.json
   ```

   **Expected:** `sourceSha` is the commit you built. `cli` is the CLI version you meant, and `node` is
   the version in `desktop/intelligence-cli.json`.

2. **The version in the app.**
   - **Mac:**

     ```sh
     defaults read /Applications/OpenBot.app/Contents/Info OpenBotBuildVersion
     defaults read /Applications/OpenBot.app/Contents/Info OpenBotSourceRevision
     ```

     **Expected:** the same `version` and `sourceSha` as `build-version.json`.
   - **Windows:** right-click `openbot-desktop.exe` in `%LOCALAPPDATA%\OpenBot`, then select
     **Properties → Details**. **Expected:** **Product version** is that `version`.

3. **The deployment it installed** (internal builds and candidates). After Install:

   ```sh
   jq . ~/OpenBot/.openbot-deployment
   jq -r '.version, .commit, (.images | to_entries[] | .value.reference)' ~/OpenBot/container-images.json
   ```

   **Expected:**
   - `.openbot-deployment` shows the manifest version and `"pinned": true`;
   - `container-images.json` names the commit you built;
   - every image reference ends in `@sha256:...`.

4. **The running containers.**

   ```sh
   docker ps --filter label=com.docker.compose.project=openbot-desktop --format '{{.Names}}\t{{.Image}}'
   ```

   **Expected:** the OpenBot containers are up, and their images are the ones in
   `container-images.json`.

5. **The Mac signature** (signed builds only):

   ```sh
   codesign --verify --deep --strict --verbose=2 /Applications/OpenBot.app
   spctl -a -t exec -vv /Applications/OpenBot.app
   ```

   **Expected:** both pass, and `spctl` says `Notarized Developer ID`.

## 5. Reset a test machine

The reset scripts return a machine to never-installed: the next launch goes through sign-in, the
agreement and Install again.

- **Mac:**

  ```sh
  desktop/scripts/reset-test-machine.sh --dry-run    # shows what it would do
  desktop/scripts/reset-test-machine.sh --remove-app
  ```

- **Windows** (PowerShell, as the person who uses OpenBot, not as administrator):

  ```powershell
  .\desktop\scripts\reset-test-machine.ps1 -DryRun
  .\desktop\scripts\reset-test-machine.ps1 -RemoveApp
  ```

They remove:
- OpenBot's containers, volumes and networks, and the Podman machine OpenBot made;
- the Intelligence stack OpenBot created, and the CopilotKit CLI sign-in;
- the evaluation agreement record, `~/OpenBot`, and the app's own data;
- with `--remove-app` / `-RemoveApp`, the app itself.

They keep:
- Docker Desktop, Podman and WSL;
- other Intelligence stacks and your browsers' data;
- images, unless you add `--images` / `-Images`.

Uninstalling the app alone is not a reset. The uninstaller and dragging to Trash both keep
`~/OpenBot` and the containers, on purpose, so that an update keeps the person's data.

## 6. Prove the process

Use this checklist to show that somebody else can repeat a build and get the same result. Write the
results in the PR or the issue for the build.

1. Choose the branch and its commit.
2. Make an internal build ([section 1](#1-make-an-internal-build)). Record the run URL.
3. Check the build record ([section 4, step 1](#4-check-a-build)). Record the commit, the CLI
   version, the Node version and the `lockfileSha256`.
4. On the Mac, reset, install and test ([sections 5](#5-reset-a-test-machine) and
   [3](#3-install-and-test)), then do the checks in section 4, steps 2 to 4.
5. On the Windows PC, do the same. Run the reset script with `-DryRun` first.
6. Write down the result:

   | Item | Value |
   |---|---|
   | Run URL | |
   | Commit | |
   | CLI version / Node version | |
   | Mac: install time, Bot answered, checks passed | |
   | Windows: install time, Bot answered, checks passed | |
   | Problems | |

7. Give this runbook, not your notes, to a second person, and ask them to do steps 2 to 6 on another
   machine. The process is proved when their result matches yours without your help.

## When something goes wrong

| What you see | What to do |
|---|---|
| **Internal build** is not in the Actions list, or `gh workflow run` says the workflow is not found | The workflow is not on `main` yet. Merge the build workflows first. |
| An image job fails | Open the failed job's log and read the first error. A Dockerfile error is a code problem on the branch. Do not run it again until you know the cause. |
| The build fails with `the pinned deployment manifest ... has commit ..., but this build compiles ...` | The installer is being built from a different commit than its images. Build both from the same commit. |
| A signing run waits | It needs an approver from the table in [Before you start](#before-you-start). |
| A stable release is published but is not Latest | It becomes Latest once both Mac and Windows signing have attached their signed installers. The attach step of the run that finished says which installers it still needs. Approve the other run. If a run failed, run it again from the release tag with `release-tag` set and `make-latest` on. |
| Mac or Windows signing of a candidate fails with `container-images.json ... was built from ...` | The signing run is not on the candidate's tag. Run it from the tag the release was published from. |
| A fixed download address gives the unsigned build | That platform's signing run was not approved, or failed. Approve it, or run it again from the release tag with `release-tag` set; its attach step replaces both names. |
| A fixed download address gives an older release | `latest/download` follows the release marked Latest. A candidate or beta is never Latest, a stable release becomes Latest only once both signing runs have attached their installers, and a patch released while a newer release is out does not become Latest. |
| Windows setup stops with a virtualization message | The machine cannot run WSL 2. Use an x64 PC or an x64 VM with nested virtualization. |
| Setup returns to Install after sign-in | The saved sign-in no longer works. Sign in again. |
| A step shows **Retry** | Select it once. If it fails again, open **Technical details** and copy them into the issue. |
| Web search does not work | Add a Composio key to `~/OpenBot/.env`. See [Install and test](#3-install-and-test). |
| `copilotkit local delete` says the CLI is busy | The reset script tries again for up to 90 seconds. If it still fails, quit OpenBot and run the reset again. |
