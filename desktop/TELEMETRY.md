# Desktop telemetry

Telemetry is enabled by default, and the first setup screen says so before anything is installed or signed in to: "OpenBot sends usage data, linked to your OpenBot account. It never sends your conversations, files or keys. You can turn this off in Settings." It links this document.

**Settings > General > Privacy > Share usage data** turns it off. Off is the same opt-out as `COPILOTKIT_TELEMETRY_DISABLED=1`, kept in `usage-data.json` in the app's configuration folder for every later launch. It takes effect at once for the desktop emitter (its identity, account binding and queue are deleted) and the bundled CLI (every call gets `COPILOTKIT_TELEMETRY_DISABLED=1`, and no `telemetry link` runs). The server reads it the next time OpenBot starts, through the suppression override below; the row says changes apply then. Turning it back on starts a fresh identity with nothing from before the opt-out.

Launching OpenBot with `COPILOTKIT_TELEMETRY_DISABLED` or `DO_NOT_TRACK` set to `true` or `1` also disables the desktop emitter, the CLI and the runtime. The variables win over Settings: the switch shows off and cannot be turned on. Quit and relaunch after changing the environment. Opting out either way removes pending desktop events and prevents recording or replay.

The native emitter starts before credentials are available. It persists a random installation UUID and a bounded queue in the app's local data directory. It does not derive identity from the machine. The runtime receives the same UUID through `CPK_TELEMETRY_ID` and uses sampling rate 1; opt-out still takes precedence.

## Account attribution

After a successful CopilotKit sign-in or an existing account check, the desktop asks the bundled CLI to verify its signed-in account on a background worker. Start retries the same handshake before handing the identity to the server. The desktop saves an opaque SHA-256 account fingerprint before requesting the alias through authenticated Ops. Credentials, email and Clerk identifiers stay outside the desktop event payload. The telemetry sink can then associate the installation UUID, including its earlier anonymous activity, with the signed-in PostHog person.

A different account rotates the UUID before linking. A CLI `signed_out` result rotates a previously bound UUID and clears the binding. Queued events keep the UUID they were recorded under. The runtime receives the resulting UUID before it starts. Terminal logout is observed at the next Start handshake; it does not change an already-running runtime's environment. Opt-out deletes the local binding along with the UUID and queue. Suppressed CLI telemetry returns `skipped` and leaves the desktop binding unchanged.

Sign-in, account-check and Start responses do not wait for attribution. The sign-in and account-check hooks schedule background work only after a successful sign-in or a required/not-required agreement result; signed-out, failed and engine-blocked checks do not. App-account setup retries attribution after it finishes, even when app provisioning fails, because that required CLI call may have cancelled an earlier handshake. This retry still verifies the signed-in account through the CLI; it does not treat provisioning success as proof of identity. Start hands the runtime the identity as it stands and schedules the same background handshake after it succeeds; an account change found then reaches the runtime at the next Start. All handshakes share one lock so account binding and alias requests cannot interleave. Duplicate background hooks skip an active handshake. Background CLI calls never queue; required account/setup calls cancel them and wait only for process termination, rather than the telemetry timeout. Each of at most two CLI calls has an eight-second budget, including waiting for the CLI lock, plus up to 250 ms for termination. Failures defer linking to the next hook. A `linked` response means Ops accepted the authenticated request; alias delivery is best-effort and requires an enabled Ops telemetry sink.

Each `telemetry link` is a CLI command with its own CLI analytics. Once a link confirms an installation and account, later hooks in the same launch skip it; a new sign-in clears that, as does a rotated installation or the next launch. A terminal logout is therefore noticed at the next sign-in or launch rather than the next Start.

The bundled CLI is pinned to `copilotkit@2e1c519` (`desktop/intelligence-cli.json`), a `CLI_ENV=production` preview of Intelligence `2e1c51900` (`6bfaa0f5c` with `local --app-path` and loopback-equivalent reconnects) with `telemetry link` and `signed_out` support, the 0.16.0-rc.10 chart and CopilotKit v1.85.0 templates. Release still needs live PostHog checks for sign-in, task use, restart, account switching and the Settings opt-out. Measure cold and warm handshake times on macOS and Windows with that pin; fake-process tests do not establish real account-link latency.

The added state fields are not readable by older desktop releases because their parsers reject unknown fields. After a downgrade, those releases disable native telemetry until a compatible version reads the state again. Do not treat a downgrade as proof that telemetry is still active.

## Desktop-only boundary

The account bridge runs only in the native desktop shell. The shell starts the personal edition; it does not identify Enterprise application users. Its server handoff uses a separate `.openbot-desktop-telemetry.yml` override, selected only when the native launch supplies desktop telemetry context (or opt-out) and the installation is personal. The shared Compose file and Enterprise deployment charts are unchanged. Ordinary Compose startup does not load the override. Desktop defaults precede user Compose overrides, preserving a server-level opt-out. A separate final suppression override makes native opt-out win even over an override that enables telemetry. If the optional Compose settings probe is unsupported or fails, or a telemetry override cannot be written, startup logs it and continues without that override, opted out or not: telemetry never keeps OpenBot from starting. The desktop identity reaches the server only through that override, so a server started without it has none.

The override forwards only the installation UUID, sampling/suppression settings, sink address and closed desktop version/platform metadata. It contains variable names, not account data or credentials. No email, name, prompt, response, recording, filename or user URL is added. The configured sink address is transport configuration, not captured browsing content. The CLI protocol rejects extra fields. Opaque account linking remains pseudonymous identification; it is not anonymous collection. This change adds no content collection or new product event names.

## Event allowlist

All desktop event names begin with `oss.desktop.`. The Rust `EventData` enum and `schema_json()` define the closed property schema; deserialization rejects unknown properties and enum values.

| Event suffix | Properties |
| --- | --- |
| `step_viewed` | Setup step enum |
| `harness_chosen` | Harness enum, including `byo_url` |
| `model_chosen` | Provider and credential-path enums; custom-base-URL boolean |
| `engine_detected` | Engine enum; responding boolean |
| `engine_installed` | Engine and installer-outcome enums |
| `windows_stage` | Windows prerequisite outcome enum |
| `image_pull` | Outcome enum, milliseconds, optional observed download bytes |
| `setup_failed` | Setup step and error-class enums; optional failing-step, CLI-reason and CLI-failure enums; optional resources (booleans and numbers) |
| `activated` | No properties; OpenBot started successfully |
| `setup_abandoned` | Last setup step enum |
| `sign_in` | Sign-in outcome enum; optional milliseconds; optional CLI-failure enum |
| `setup_stalled` | Journey enum and timed-step enum; typical and elapsed seconds |
| `ui_stalled` | Setup step enum; seconds the window did not answer |

For `model_chosen`, providers are `openai`, `anthropic`, `google`, `xai`, `compatible`, or `none`; credential paths are `subscription`, `api_key`, `oauth`, or `none`. OpenAI and Anthropic plan sign-ins use `subscription`. Google and xAI native sign-ins use their named provider with `oauth`; their API-key routes use `compatible`, matching the picker’s endpoint choice. A compatible endpoint uses `api_key` only when a nonblank key is supplied or its saved key is explicitly selected; keyless endpoints use `none`. Skipping model setup uses provider and credential path `none`. `custom_base_url` records only whether a nonblank base URL was selected, never its value.

`setup_failed` is sent by the desktop itself, never by the window, from every failed install or Start (once: a step that already said it failed is not counted again, and a Start cancelled by Stop is not a failure), and from every failed `local setup`, `local start`, `local update`, `local connect`, the Learning model's setup after Start, and an Account-step check that stops setup (an engine too small, or one local setup does not run on). `step` is the last screen shown; `failing_step` names the part that failed by the setup rows' step names (`install_engine`, `services`, `local_setup`, `account_check`, ...). `error_class` comes from the step, or where the step says nothing, from the failure's words, of which only the class is kept. `cli_reason` and `cli_failure` are the CLI's closed reason and the desktop's closed failure category. `resources`, for an engine too small, has `cpu_short`, `memory_short` and `disk_short`, and what setup needs against what was measured: CPUs in thousandths, memory and disk in MiB; anything not measured is absent.

`setup_stalled` and `ui_stalled` report a hang, which is not a failure and so is never a `setup_failed`. Both are sent by the desktop itself, never by the window, with closed names and seconds only: never what the window showed, a log line, or what the step was working on.

`setup_stalled` is a step that runs three times as long as it typically takes, and two minutes over at least, sent once per step. `part` is the journey: `setup` (the back end's `local setup`), `update` (`local update`), `start` (OpenBot's own start, by its setup rows) or `release` (OpenBot updating itself). `step` is the CLI's step (`dependencies_wait`), the start row (`services`) or the update's step (`backing_up`), from the closed list in `schema_json()`. `typical_seconds` is the journeys' measured time for that step (`desktop/src/journey.ts` and `StartJourney.tsx`; `desktop/src/journeyTimings.json` mirrors them for the native side and `journeyTimings.test.ts` keeps the two equal), and `elapsed_seconds` how long it had run. A step that then finishes sends nothing more; one that fails is a `setup_failed`. Downloads are measured by their bytes rather than timed as steps, so the download steps are not in the list, and a download that is moving restarts the clock of the step it holds up. The CLI logs a step when it ends, so its running step is the one after the furthest it logged.

`ui_stalled` is a setup window that stopped taking what the desktop sends it. While the setup, start or update screens show, the page invokes `setup_heartbeat` every five seconds, and as soon as a row's progress reaches it, with the highest progress number it has taken (`setup:progress` carries one). The heartbeat is never awaited and runs off the window's thread. Progress left untaken for over 30 seconds while the window is shown, not minimised and, on macOS, not covered is a stall. The Desktop log says `[ui] the window has not answered for 31s during start_machine` when it is noticed and `[ui] the window stopped answering for 42s during start_machine` when it ends, and that end sends one `ui_stalled` with `stalled_seconds` and `step`, the setup row the desktop was reporting, by the same names as `failing_step`. It ends when the page catches up, the window leaves the screen, the window loads another page, or OpenBot quits. A page that has just loaded counts what was sent before it listened as taken, and a page that sends no heartbeat (OpenBot itself) is not watched.

`sign_in` is the Account step's CopilotKit sign-in: `started`, then `completed`, `failed` or `cancelled` with how long it took, and `restored` once a launch when the account check finds this computer already signed in without a sign-in.

Every event, the two stall events among them, carries desktop distribution, app version (numeric, with a release candidate's closed label such as `1.0.0-rc.5`), platform, architecture, numeric OS version when available, and engine. The runtime receives the same desktop metadata through its existing `telemetryProperties` hook, where the app version accepts only the same closed pre-release labels. No prompt, answer, credential, file name, path, hostname, email, model name, YAML value, or custom URL is accepted by the desktop schema.

Image timing covers an explicit missing-only Compose pull, excluding startup and migrations. Byte counts are the download counters observed from Compose, deduplicated per layer; they are not an exact network total. Missing counters remain null. Older Compose providers without `pull --policy missing` retain their existing implicit pull behavior and emit no pull measurement.

## Delivery and verification

Events persist before sending and keep their event IDs across retries. The queue holds at most 256 events, dropping the oldest on overflow. Background delivery, bounded quit flushing, and replay on relaunch use the existing CopilotKit ingest contract. A crash before activation records abandonment on the next launch. Telemetry failures do not block setup.

The ingest must accept the new `oss.desktop.*` namespace: [oss-path-to-production #290](https://github.com/CopilotKit/oss-path-to-production/pull/290). A successful HTTP response alone does not prove downstream acceptance; production ingest acknowledges filtered events too. Merge and deployment of that change are required for production desktop delivery.

Regression tests live in the native telemetry, stall (`stall.rs`, `desktop_stall.rs`) and pull-metrics modules, frontend telemetry, heartbeat and journey-timing tests, and server metadata tests. For an actual local HTTP and installed-runtime check, build the native probe and run the driver from the repository root:

```sh
cargo build --manifest-path desktop/src-tauri/Cargo.toml --release --example telemetry_probe
bun desktop/scripts/validate-telemetry.ts desktop/src-tauri/target/release/examples/telemetry_probe
```

The probe also accepts `provider-canary` to send three synthetic `model_chosen` events: Google OAuth, xAI OAuth, and a keyless compatible endpoint. It keeps `runtime_env=test`, uses a random installation UUID in the supplied data directory, and accepts only a loopback HTTP receiver. No credentials, model names, or endpoint values are included:

```sh
telemetry_probe /path/to/fresh-data-dir http://127.0.0.1:PORT/ingest provider-canary
```

The driver uses temporary data and a loopback receiver. It exercises separate-process persistence/replay, quit, activation deduplication, opt-out, and the installed runtime's identity/metadata handoff. It does not require AI credentials or send validation events to production. Windows and Linux execution remain covered by the platform CI runs; a Mac run is not proof of their native UI behavior.

Local HTTP validation is reusable through `desktop/scripts/validate-telemetry.ts` with the separately built `telemetry_probe` example. It checks offline queue replay with stable installation/event IDs, recovered abandonment, quit flushing, activation once across process restarts, native/runtime metadata, and both `true`/`1` values of `COPILOTKIT_TELEMETRY_DISABLED` and `DO_NOT_TRACK`. Opt-out must remove queued state and identity and produce zero HTTP sends.

The September 12 local run used installed runtime 1.70.1 and its public ESM Hono factory, following the production `eventsource` preload. Its existing Bun dependency layout needed an explicit `NODE_PATH` pointing at the existing hoist directory so a cached `gaxios` module could resolve `extend`. No dependency was installed or modified. Reproduce that adapter from the repository root:

```sh
NODE_PATH="$PWD/node_modules/.bun/node_modules" bun --no-env-file --no-install desktop/scripts/validate-telemetry.ts /absolute/path/to/telemetry_probe
```

The final loopback report recorded five native requests and one runtime request with matching installation identity, with all four opt-out cases passing. This covers the emitter and installed-runtime HTTP contract; fresh dependency installation and final PostHog delivery still require their own validation.
