# Desktop install: the flow and why it is built this way

This page is for the people and agents who change the desktop app's setup. It describes what
happens from the first click to an open OpenBot, which part owns each step, and the decisions
behind the design. The code comments named here hold the details; this page is the map.

## What the desktop app is

The desktop app installs and runs OpenBot for one person on one computer, with CopilotKit
Intelligence running on the same computer. The person needs no terminal, no developer tools and no
container engine of their own. The app is standalone: there is no hosted or self-hosted
Intelligence option, no organization sign-in and no Bot picker. It installs the default Bot.

First-release platforms are Apple silicon macOS and Windows x64. Windows on ARM cannot run
WSL 2 inside a virtual machine on Apple silicon, so test Windows builds on an x64 machine.

## The flow

The window shows four sections: **Account**, **Install**, **AI** and **Start**
(`desktop/src/Sections.tsx`). Some work runs in parallel behind them.

```mermaid
sequenceDiagram
  participant P as Person
  participant W as Window (App.tsx)
  participant N as Native side (src-tauri)
  participant C as Intelligence CLI (bundled)
  P->>W: Install (Welcome)
  W->>N: prepare_installation (Install starts at once)
  N->>N: engine, deployment download, image pulls
  W->>N: sign_in_to_copilotkit (Account opens)
  N->>C: login (no engine needed; opens the browser)
  Note over W,N: macOS only, when Podman needs installing: the window says the password prompt<br/>is coming and why, and it comes up by itself a moment later
  W->>N: local_eval_terms, once an engine answers
  N->>C: onboard local-terms
  P->>W: Accept the evaluation agreement
  Note over W,N: Once the engine answers, Intelligence setup is queued
  W->>N: set_up_local_eval
  N->>C: local setup
  P->>W: Choose an AI provider and key (AI)
  P->>W: Continue
  W->>N: connect_local_eval, run_local_eval
  N->>C: local connect, local start / status
  W->>N: start_stack
  W->>N: show_openbot
  Note over W: The window becomes OpenBot
```

1. **Welcome.** The first click starts Install in the default folder, `~/OpenBot`. Install needs
   no account, so it runs while the person signs in.
2. **Account.** The browser sign-in opens as soon as the step does: the CLI's `login` needs no
   container engine, and answers at once for a sign-in it already has. Then the person accepts the
   local evaluation agreement, which the CLI reads only once an engine answers (`onboard
   local-terms` checks the engine first), so on a new computer the step waits for Install here and
   says what Install is doing. Nothing licensed is set up before this acceptance.
3. **Install.** The app makes a container engine answer, lays out the deployment, and pulls the
   images. The screen shows each image, its size and the download speed
   (`desktop/src/SetupProgress.tsx`, `src-tauri/src/pull_metrics.rs`). Intelligence setup starts
   as soon as the engine answers, not after the whole install, because Intelligence runs on the
   same engine.
4. **AI.** The person chooses a provider and gives a key or signs in with that provider. If Start
   is later refused because of the model, the person comes back here and changes it.
5. **Start.** Continue starts everything in order: connect OpenBot to the local Intelligence, start
   Intelligence, start OpenBot, then open it. The window becomes OpenBot as soon as the stack
   answers. There is no question step before the handover.

A return visit with a recorded local stack goes straight to Start. Any other saved state,
including an installation that an earlier app connected to a hosted Intelligence, starts at the
first screen and keeps its finished install.

## Usage data and account attribution

The first setup screen says that OpenBot sends usage data linked to the person's OpenBot account
(their CopilotKit sign-in), that it never sends conversations, files or keys, and links
[Desktop telemetry](../desktop/TELEMETRY.md). **Settings > General > Privacy > Share usage data**
turns it off. Off is the same opt-out as launching with `COPILOTKIT_TELEMETRY_DISABLED=1`: it is
kept for the next launch, the desktop's own events and identity are deleted at once, every CLI call
gets the variable, no `telemetry link` runs, and the server gets it the next time OpenBot starts.
With `COPILOTKIT_TELEMETRY_DISABLED` or `DO_NOT_TRACK` set at launch, the switch shows off and
cannot be turned on.

After a successful CopilotKit sign-in, an existing-account check, app setup, or a successful Start,
the native shell runs the bundled CLI's `telemetry link --installation-id <UUID> --json` on a
background worker. The CLI uses its verified Ops session to return an opaque account fingerprint.
Desktop saves that binding before calling again with `--account-id <hash>`. Ops emits the existing
identity-link event; the telemetry sink aliases the desktop UUID to the Clerk person in PostHog. The
desktop never reads CLI credential files or adds email addresses to product events.

The first account keeps the existing installation UUID, so its anonymous setup history can join the
account. A different account gets a new UUID before linking. A signed-out CLI result clears a
previous binding and rotates the UUID. Queued events keep the UUID they were recorded under,
including queues written by older desktop versions. The personal-edition runtime receives the
current UUID through `CPK_TELEMETRY_ID` when it starts. Only the native desktop launch selects the
separate telemetry Compose override; shared Compose and Enterprise charts are unchanged. The handoff
adds no readable PII or user content. Opaque account linking is pseudonymous, not anonymous.

Nothing here can keep OpenBot from opening. Sign-in and Start never wait for `telemetry link`: Start
hands the runtime the identity as it stands and links afterwards, so an account change found then
reaches the runtime at the next Start. Required CLI calls preempt optional linking, and duplicate
hooks do not queue. Each of at most two CLI calls has an eight-second budget plus 250 ms kill grace;
a failure logs a fixed deferred message and retries at the next hook. Once a link is confirmed for
an installation and account, later hooks in the same launch skip it until the next sign-in, which
keeps the CLI's own analytics to one link per account per launch; a terminal logout is noticed at the
next sign-in or launch. If the optional Compose settings probe fails or a telemetry override cannot
be written, Start logs it and continues without the override, opted out or not.

A successful CLI response means Ops accepted the authenticated verify request. Aliases are
best-effort and require the Ops telemetry sink to be enabled. The bundled CLI is pinned to a
`CLI_ENV=production` build that includes `telemetry link` (`desktop/intelligence-cli.json`).
Validate a real sign-in, task and restart under one PostHog person, then switch accounts and verify
that the second person's activity remains separate. Production delivery has not been established by
the local tests.

## Who owns what

| Owner | Owns |
|---|---|
| Window (`desktop/src`) | Screens, order, what the person reads. Holds no credentials. |
| Native side (`desktop/src-tauri`) | Engine install, deployment layout, images, Compose, host processes, secrets, Stop and Quit. |
| Intelligence CLI (`copilotkit`, bundled) | Intelligence topology, sign-in, licence, readiness and its endpoints. |

**The CLI owns Intelligence.** The app runs the CLI as a bounded child process
(`src-tauri/src/local_eval.rs`) and never reads its credential files or probes its containers to
fill a gap. Three rules hold that boundary:

- **Nothing unverified runs.** The CLI and its Node runtime are bundled into the installer and
  checked by SHA-256. There is no fallback to `PATH`, `npx` or a global install.
- **Arguments are fixed.** Only known subcommands, a validated stack id and `--json`, with no
  shell. The CLI's `resumeCommand` text is never executed. The account sign-in adds
  `--mode openbot`, so the sign-in page explains OpenBot's setup, only when the CLI's own
  `login --help` lists it: an older CLI refuses an unknown flag.
- **Only allowlisted facts cross into the window.** Raw stdout and stderr never reach the window or
  a log. Readiness and licence come only from the exact values of `local status`; anything else
  reads as unknown, and unknown keeps chat closed.

## Decisions and the reasons for them

- **Install before sign-in, sign-in before the engine.** Downloading software needs no account, and
  it is the slow part. Starting it on the first click means the person signs in while it runs. The
  sign-in waits for nothing: someone who leaves while Podman installs has still signed in.
- **No password prompt without an explanation first, and no click before one.** On macOS, Podman's
  package needs an administrator, so macOS asks for the person's password. Install downloads the
  package, says "Your Mac will ask for your password so OpenBot can install what it needs to run.",
  leaves it a moment to be read (`install::BEFORE_PROMPT`), and raises the prompt by itself. An
  install step informs the person and moves forward. The prompt says why in OpenBot's words
  (`do shell script ... with prompt`). Closing it without a password is said plainly, with Try
  again, and Install asks again by itself after a short wait (`install::GoAhead`,
  `ASK_AGAIN_AFTER`). Windows installs Podman for the person's own account with no prompt. When
  WSL is missing, the Windows blocker says what Windows will ask and starts the change by itself;
  a declined administrator prompt is asked again the same way. The restart after it is the one
  step that waits for the person's click: OpenBot never restarts the computer on its own, because
  the person may have unsaved work open.
- **Licence work after acceptance.** Intelligence setup waits for the evaluation agreement, and
  uses the version of the terms the person accepted.
- **One engine for both.** OpenBot and Intelligence share one container engine. The app uses, in
  order: a Docker that answers; on macOS and Windows a stopped Docker Desktop that has run before,
  which it opens; otherwise Podman, which it installs and runs as a rootful machine, because k3d
  needs a rootful engine. The choice is saved with the installation, and later runs use only that
  engine (`src-tauri/src/install.rs`, `acquire.rs`).
- **The person's own Podman machine is left as it is.** A machine made with `podman machine init`
  is rootless, which local Intelligence can't run on, and on Windows any machine but OpenBot's lacks
  the networking OpenBot's containers need to reach Intelligence (user-mode networking and the
  host-gateway setting). So OpenBot passes such a machine over and makes and uses its own rootful
  machine, `openbot`, as on a computer with none (`engine::passed_over_machine`). On Windows it runs
  beside the person's, which keeps running untouched. While `openbot` starts, the app holds the name
  of Docker's default pipe, `\\.\pipe\docker_engine`, which Podman otherwise gives to the first
  machine that starts, so `openbot` gets only its own pipe (`acquire::DOCKER_PIPE`). On a Mac, where Podman runs one machine at a
  time, a rootless machine of the person's is the only kind passed over: the window says OpenBot
  needs its own and offers to pause theirs while OpenBot runs, and nothing is paused until they
  choose **Pause my Podman**. Quit then stops `openbot` and starts theirs again with the containers
  that were running in it (`src-tauri/src/own_machine.rs`). A rootful machine on a Mac, and Docker,
  are used as before. The person's default Podman connection is never changed.
- **An engine too old to run OpenBot is updated for the person.** At setup and at every Start,
  before Compose reads the project, the app reads the engine's version and its Compose version and
  compares them with the minimums in `src-tauri/src/engine_versions.rs`: Compose 2.27.2 (the first
  with `config --environment`, which Start uses), Docker Engine 20.10 and, on macOS and Windows,
  Podman 6.1. A Podman that is too old gets OpenBot's own pinned installer run over it, and an old
  Compose gets OpenBot's own placed in front of it; machines and their data are kept. Every Podman
  machine running before the update, the person's own included, is running afterwards with its
  Docker API answering: on Windows each is stopped before the MSI and started after it, and any
  whose API does not answer is stopped and started, with the containers that were running in it
  (`install::update_podman`). The row says why: "The Podman on this computer is too old for
  OpenBot, so OpenBot is updating it." Nothing is called updated until the engine answers. At every
  check on macOS and Windows, a Podman machine that answers `podman` (over SSH) while its Docker API,
  the pipe or socket Compose uses, does not is stopped and started once ("Restarting the software
  OpenBot runs on."), and one that still does not answer is a failure with Try again
  (`engine_versions::ensure`, `acquire::engine_answers`). The machine is the one OpenBot reaches,
  through Podman's default connection when detection found it there (`acquire::machine_reached`). A
  relaunch does the same before the back end is asked (`wake_engine`), whose own check says only
  that Docker is unavailable, and Stop and Quit do it once before both their stops (`compose
  down` and the back end's `local stop`). The install's `engine` row is said done only after this
  check, so the back end's setup, which starts on it, never runs against an engine about to be
  updated. While a row says the engine is updating, the account's licence check is not asked; one
  refused before that waits for the engine instead of asking again. A Docker
  Desktop that is too old (4.31 and earlier) is updated to Docker's newest release with Docker's
  own installer command line, after its checksum and Docker's signature are checked
  (`src-tauri/src/docker_desktop_update.rs`). The containers running before Docker Desktop is quit
  are started again once it answers. Docker's terms are never accepted for the person. Only
  what cannot be updated (a Docker that is not Docker Desktop, an old Podman on an Intel Mac, a
  macOS or Windows too old for the newest Docker Desktop) is one plain step. Linux is left as it is.
  `cargo run --example engine_update_check` shows what the app would do on a machine without
  changing anything.
- **Everything fetched is pinned.** Engine installers, Compose, the CLI and Node are pinned by
  digest. A mismatch is refused, never run. Docker Desktop's update is the exception, because only
  Docker's newest release is offered: it is checked against its build's published checksum and
  Docker's code signature instead.
- **A small installer, a downloaded deployment.** The installer is the app and the bundled CLI.
  The deployment is `docker-compose.yml`, out of the release's source tarball at a tag, laid out
  under the installation folder; everything else, server, app, worker, computer and tenant package,
  runs from the images that release's `container-images.json` names by digest
  (`src-tauri/src/deployment.rs`). Nothing runs on the host: the person's own browser runs on the
  one computer and is shown in the OpenBot window, as hosted OpenBot shows it.
  A new deployment takes the latest release. An existing one keeps its version through Install
  and Repair; the first Start after the app updates itself upgrades it to the app's own release
  (`src-tauri/src/upgrade.rs`, [desktop updates](desktop-updates.md)).
- **The app's own Compose project.** Every new installation runs as the Compose project
  `openbot-desktop`, not the folder's name. A source checkout called `openbot` would otherwise share
  containers and volumes with the app (`src-tauri/src/stack.rs`, `project`).
- **An upgrade keeps its data.** An installation an earlier app made ran as its folder's name
  (`openbot` for `~/OpenBot`), and Stop and Quit took its containers down. It keeps that project,
  and with it its database and its Bots' computers, when an earlier app finished installing in the
  folder and the project's database volume is still on the engine. If another folder is running
  that project right now, Install says so and decides nothing until it stops. Nothing is deleted.
- **Images download in parallel, with progress.** Four images download at once
  (`IMAGE_PULLS_AT_ONCE`). The screen shows what is downloading and how fast, so a slow network
  looks slow, not stuck.
- **A dropped download is tried again.** A file download whose connection fails, or whose server
  answers 5xx or 429, is tried up to three times (`deployment::get`). A 404 is reported at once.
  `install.rs` still checks the digest of whatever arrives.
- **Secrets stay out of `.env`.** `.env` holds settings a person can read. Model keys and service
  tokens go to an owner-only file on macOS and Linux and to DPAPI on Windows, and reach processes
  only as environment (`src-tauri/src/vault.rs`). A value never goes on a command line.
- **Open as soon as it answers.** An earlier design asked the Bot a test question before the
  handover. It was removed: the stack answering is the signal, and a failure inside OpenBot is
  shown there.
- **A stale sign-in goes back to Install.** If the saved CopilotKit sign-in no longer works, the
  app returns the person to the step that can fix it instead of stopping on the AI step.
- **Changing the AI retries a refused Start.** If Start was refused because of the model, choosing
  another one runs Start again with it.
- **Failures in two registers.** Every failure has `said`, a sentence a person reads, and
  `detail`, the real output behind a disclosure (`src-tauri/src/problem.rs`). Raw engine output is
  never the headline.

## Stop, Quit and uninstall

- **Stop** stops OpenBot first, then the local Intelligence stack that OpenBot created. A stack
  OpenBot did not create is left alone.
- **Quit** runs the same order with time limits: host processes, Compose down, then Intelligence,
  with up to 120 seconds for the CLI. The screen reports each part, and a part that did not stop
  always gets its row (`exit_cleanup_reporting` in `src-tauri/src/main.rs`).
- **Windows install and uninstall** first stop every process running from the installation's own
  `cli-bundle`. The CLI's background sign-in service keeps `node.exe` open, and Windows cannot
  replace or delete an open file. No other `node.exe` is touched (`src-tauri/windows/hooks.nsh`).

## Where things are on disk

| Path | What |
|---|---|
| `~/OpenBot/` | The installation: deployment, `.env` settings, `.openbot-*` records |
| `~/OpenBot/.openbot-project.json` | The Compose project this installation runs as |
| `~/OpenBot/.env` | Settings only. A person's own `COMPOSIO_API_KEY` goes here and always wins |
| Protected store (see `vault.rs`) | Model keys, service tokens and a provisioned Composio key |
| `%LOCALAPPDATA%\OpenBot` (Windows) | Recorder host files, and the browser profile earlier versions kept in `local-computer` |

## Apps through Composio

A person's own Composio key, in `.env` or the environment, is passed to the server at Start and is
never moved or rewritten (`src-tauri/src/composio.rs`, `resolve`).

Without one, the app gets this installation's own Composio project from CopilotKit, with the
CopilotKit sign-in the bundled CLI already holds. The CLI runs `integrations composio provision`
(`local_eval.rs`, `apps_arguments`): it posts the installation id to Ops with its own session, and
writes the project key into `~/OpenBot/.openbot-apps/composio.env`, an owner-only folder the app
removes as soon as it has read the key. The key goes to the protected store as
`COMPOSIO_PROVISIONED_API_KEY`, never to `.env`, and Start passes it to the server as
`COMPOSIO_API_KEY`. The app never reads the CLI's session.

It runs on the Account step once the person is signed in, where a failure shows Connect apps and
Continue, and on every Start of an installation with local Intelligence that still has no key. An
installation signed in under 0.3.0 gets its key on its next Start. Ops replays the same key for an
installation, so a retry never makes a second project. A failure never stops Start: OpenBot starts
with apps unavailable.

## Builds

An installer bundles the Intelligence CLI chosen in `desktop/intelligence-cli.json` and a Node
runtime pinned by version and SHA-256. Internal builds and release candidates also pin the
deployment and its images to the exact commit they were built from, and refuse to start a
deployment from another release; see [Releasing](releasing.md) once that change is merged.

## Where to start in the code

| Area | Files |
|---|---|
| Screens and order | `desktop/src/App.tsx`, `Welcome.tsx`, `CopilotKitAccount.tsx`, `ProviderPicker.tsx`, `LocalIntelligence.tsx` |
| CLI calls from the window | `desktop/src/localEvalCli.ts` |
| CLI process boundary | `desktop/src-tauri/src/local_eval.rs`, `local_eval_state.rs` |
| Engine | `desktop/src-tauri/src/install.rs`, `acquire.rs`, `docker_desktop.rs`, `engine.rs` |
| Deployment and release | `desktop/src-tauri/src/deployment.rs`, `deployment_release.rs`, `preparation.rs` |
| Compose and processes | `desktop/src-tauri/src/stack.rs`, `supervise.rs` |
| Image downloads | `desktop/src-tauri/src/pull_metrics.rs`, `desktop/src/SetupProgress.tsx` |
| Secrets | `desktop/src-tauri/src/vault.rs`, `saved_intent.rs` |
| Windows installer hooks | `desktop/src-tauri/windows/hooks.nsh` |

## Testing a change

- `desktop/src/App.test.tsx` covers the flow screen by screen. Run `bun test src` in `desktop`.
- Rust: in `desktop/src-tauri`, run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`
  and `cargo test --locked --lib --bins`.
- To test a real first run, remove what the previous run left: the containers and volumes of the
  `openbot-desktop` project, the local Intelligence stack the app created (`copilotkit local
  delete`), `~/OpenBot`, and the CLI sign-in (`copilotkit logout`). Otherwise the app resumes
  instead of starting fresh.
