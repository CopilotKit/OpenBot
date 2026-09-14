# Desktop telemetry

Telemetry is enabled by default. Welcome discloses it without an opt-in gate. Launch OpenBot with either `COPILOTKIT_TELEMETRY_DISABLED=true` or `DO_NOT_TRACK=1` to disable both the desktop emitter and the runtime. Both variables accept `true` or `1`. Quit and relaunch after changing the environment. Opting out removes pending desktop events and prevents recording or replay.

The native emitter starts before credentials are available. It persists a random installation UUID and a bounded queue in the app's local data directory. It does not derive identity from the machine. The runtime receives the same UUID through `CPK_TELEMETRY_ID` and uses sampling rate 1; opt-out still takes precedence.

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
| `setup_failed` | Setup step and error-class enums |
| `activated` | No properties; first successful setup Bot answer |
| `setup_abandoned` | Last setup step enum |

Every event carries desktop distribution, numeric app version, platform, architecture, numeric OS version when available, and engine. The runtime receives the same desktop metadata through its existing `telemetryProperties` hook. No prompt, answer, credential, file name, path, hostname, email, model name, YAML value, or custom URL is accepted by the desktop schema.

Image timing covers an explicit missing-only Compose pull, excluding startup and migrations. Byte counts are the download counters observed from Compose, deduplicated per layer; they are not an exact network total. Missing counters remain null. Older Compose providers without `pull --policy missing` retain their existing implicit pull behavior and emit no pull measurement.

## Delivery and verification

Events persist before sending and keep their event IDs across retries. The queue holds at most 256 events, dropping the oldest on overflow. Background delivery, bounded quit flushing, and replay on relaunch use the existing CopilotKit ingest contract. A crash before activation records abandonment on the next launch. Telemetry failures do not block setup.

The ingest must accept the new `oss.desktop.*` namespace: [oss-path-to-production #290](https://github.com/CopilotKit/oss-path-to-production/pull/290). A successful HTTP response alone does not prove downstream acceptance; production ingest acknowledges filtered events too. Merge and deployment of that change are required for production desktop delivery.

Regression tests live in the native telemetry and pull-metrics modules, frontend telemetry tests, and server metadata tests. For an actual local HTTP and installed-runtime check, build the native probe and run the driver from the repository root:

```sh
cargo build --manifest-path desktop/src-tauri/Cargo.toml --release --example telemetry_probe
bun desktop/scripts/validate-telemetry.ts desktop/src-tauri/target/release/examples/telemetry_probe
```

The driver uses temporary data and a loopback receiver. It exercises separate-process persistence/replay, quit, activation deduplication, opt-out, and the installed runtime's identity/metadata handoff. It does not require AI credentials or send validation events to production. Windows and Linux execution remain covered by the platform CI runs; a Mac run is not proof of their native UI behavior.

Local HTTP validation is reusable through `desktop/scripts/validate-telemetry.ts` with the separately built `telemetry_probe` example. It checks offline queue replay with stable installation/event IDs, recovered abandonment, quit flushing, activation once across process restarts, native/runtime metadata, and both `true`/`1` values of `COPILOTKIT_TELEMETRY_DISABLED` and `DO_NOT_TRACK`. Opt-out must remove queued state and identity and produce zero HTTP sends.

The September 12 local run used installed runtime 1.70.1 and its public ESM Hono factory, following the production `eventsource` preload. Its existing Bun dependency layout needed an explicit `NODE_PATH` pointing at the existing hoist directory so a cached `gaxios` module could resolve `extend`. No dependency was installed or modified. Reproduce that adapter from the repository root:

```sh
NODE_PATH="$PWD/node_modules/.bun/node_modules" bun --no-env-file --no-install desktop/scripts/validate-telemetry.ts /absolute/path/to/telemetry_probe
```

The final loopback report recorded five native requests and one runtime request with matching installation identity, with all four opt-out cases passing. This covers the emitter and installed-runtime HTTP contract; fresh dependency installation and final PostHog delivery still require their own validation.
