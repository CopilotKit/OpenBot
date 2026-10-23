# OpenBot local installer — implementation handoff

Date: 2026-10-20. Take ownership of implementation in this checkout. The user wants to start coding today; the requirements and initial contract code are ready. Continue useful implementation through concrete, tested slices. Do not publish, deploy, or accept third-party legal terms on the user's behalf.

## Read first

- **Authoritative updated artifact:** `/Users/d/orca/workspaces/openbot/herring/docs/artifacts/openbot-local-eval-requirements-v2.html`. Read its full requirements, decisions, architecture, lifecycle, coding sequence, implementation progress, and release gates. It is a standalone interactive HTML page with a Present mode.
- **Foundation plan:** `/Users/d/orca/workspaces/openbot/herring/docs/superpowers/plans/2026-10-20-local-eval-cli-boundary.md`. Tasks 1–3 are complete; native runner and live integration follow. This directory is gitignored, so preserve the plan deliberately if preparing a review.
- **Existing new code:** `desktop/src/localEvalCli.ts` and `desktop/src/localEvalCli.test.ts`.
- Read applicable repository instructions before editing. Preserve `docs/artifacts/openbot-local-eval-requirements-r21.html`; it is the original version.

## Settled requirements

The required flow is: **download small installer → install everything → run OpenBot → sign in with CopilotKit → choose AI provider → success**.

First-release platforms are **Apple silicon macOS and Windows x64**. Intel Macs and Windows ARM are deferred until validated. The installer owns dependency installation, runtime setup, and resource configuration. Users must not install Docker, use terminal commands, install developer tools, or resize VMs manually. Standard OS permission prompts and a Windows restart with automatic resume are explicitly acceptable.

The primary architecture is **Docker Desktop with CLI-managed k3d Intelligence**. The user's Docker concern is an off-ramp if Desktop licensing/distribution terms prove unsuitable. A separate Podman investigation exists; do not switch the default or block primary implementation waiting for it. Do not adopt a strict ban on Docker components or containers from older research.

Desktop owns installer orchestration, dependencies, UI, recovery, and machine lifecycle. The Intelligence CLI owns Intelligence topology, auth exchange/refresh, licence lifecycle, readiness, and endpoints. Consume structured CLI contracts; do not recreate its installer, probe internal containers to infer missing facts, or parse its credential files.

Prepare distributable software and runtime before sign-in. Licence-bound provisioning begins after CopilotKit sign-in and explicit current EULA acceptance. Pre-auth protected payload distribution is a release gate. Select the sole eligible org automatically; otherwise show the org choice during sign-in. Acceptance belongs to the accepting person and selected org.

Use browser auth with one-time codes through stdin or protected IPC. Never put secrets/codes in argv, logs, or status. Use OS-backed secure storage for credentials and provider keys. Validate the user's provider key with a minimal request; invalid keys stay editable in setup. Chat requires canonical licensed and ready Intelligence, running and connected OpenBot, and a validated provider. Unknown is blocked, never guessed ready.

Start runtime, then Intelligence, then OpenBot. Stop OpenBot before Intelligence. Stop an installer-owned runtime only when safe for unrelated workloads. Preserve per-Bot data and folder confinement; use targeted retry/recovery rather than destructive teardown. Keep CLI Intelligence endpoints separate from OpenBot ports.

Initial capacity estimates (16 GB host RAM; runtime 8 GiB minimum/12 recommended, 4 CPUs, 50 GiB disk) and the under-15-minute target are unmeasured. Treat them as qualification targets. Licence warnings use actual expiry within five days; renewal/EULA remain explicit. Diagnostics must redact credentials, auth codes, chat, and persistent user data.

The user prefers factual presentation with no marketing language or startup CTA copy.

## Current workspace and work completed

Worktree: `/Users/d/orca/workspaces/openbot/herring`.
Orca worktree ID: `e94d6b71-21b7-4183-a5e1-6a4b7efbac4a::/Users/d/orca/workspaces/openbot/herring`.
Branch: `dustywusty/feat-local-eval-installer`.
OpenBot baseline: `3c73cf00efba46122dfd0447485e2b61f1d6a2cd`.

There are no implementation commits yet. Both TypeScript files are untracked, as are the artifact and research directories. Preserve existing work. Leave unrelated `docs/.DS_Store` alone. This handoff uses the same checkout so the new agent receives the uncommitted files.

`localEvalCli.ts` implements a bounded version-1 CLI status parser and fixed argument builder only. It is not imported into the app and executes no process. The parser caps UTF-8 input at 1 MiB, validates the envelope and stack identifier, retains allowlisted observations, validates loopback HTTP/WS endpoints (including the CLI's single-label `.localhost` dashboard), and strips raw auth/error/recovery fields. Error categories are static and contain no raw payload. Canonical licence and readiness remain `unknown` because the current CLI does not provide either fact. `localCommandArgs` permits only status/start/stop with separate fixed arguments; it also validates at runtime.

No native Rust modifications remain from this foundation. Cargo and rustc were unavailable in the previous shell, including standard installation paths. Arrange a suitable toolchain or test host as needed; do not claim native validation from the frontend build.

## Verified before handoff

- `bun test desktop/src/localEvalCli.test.ts`: 29 passing contract tests.
- `bun test desktop/src`: 175 pass, 0 fail, 902 assertions.
- `bun run --cwd desktop typecheck`: passed.
- `bun run --cwd desktop build`: passed (frontend only).
- Biome format and lint for both new files: passed. `git diff --check`: passed.
- Artifact smoke, navigation, Present mode, mobile overflow, and source links checked; no JS errors found.
- Original r21 artifact SHA-256 remains `51fdd0d798547fb35fae2ac9536c9e5cc2d26329dac848b0fbc77a193bfb9491`.

Bun 1.3.14 is available. Desktop dependencies were installed with `bun install --cwd desktop --frozen-lockfile`; no lockfile changes. Full test log: `/tmp/openbot-desktop-tests.log`. Revalidate after changes; these are prior results.

## Next implementation slice

1. Inspect the actual code and extend the plan for a bounded native CLI subprocess adapter. Resolve a verified pinned executable; independently validate actions and stack IDs in Rust. Use argument arrays without a shell. Bound stdout/stderr and time, support cancellation and child cleanup, and return sanitized failure categories. Never execute CLI-provided recovery command strings.
2. Wire Tauri and setup UI through the typed boundary. Keep runtime, Intelligence, OpenBot, and provider states independent. Preserve unknown/blocked states until authoritative contracts exist. Test command outcomes, cancellation, limits, and gating with meaningful fixtures.
3. Extend installer checkpoints and recovery toward the agreed sequence. Coordinate missing CLI capabilities rather than inventing flags, licence facts, or successful sign-in.
4. Keep the v2 artifact's progress and release gates accurate as implementation advances. Platform clean-machine validation remains necessary.

## Intelligence CLI evidence and outstanding contracts

Nearby repo: `/Users/d/orca/workspaces/Intelligence/local-evaluation-cold-install`. The checked live `origin/main` was `3935afbfe3cda88dfeabfd0250db08ff0ad51000`; verify before relying on newer behavior. Read with `git show` without changing someone else's checkout. If coordinated edits are needed, use an appropriate isolated checkout and its instructions.

- `apps/cli/src/commands/local.ts`: v1 JSON envelopes and `local status/start/stop --stack ID --json`. `status: completed` means the command completed, not that Intelligence is ready or licensed.
- `apps/cli/src/services/local-manager.ts`: stack metadata and pod observations; no canonical licence validity/expiry or overall readiness.
- `apps/cli/src/services/local-platform.ts`: native Windows, Podman, rootless, and unknown engines currently rejected; macOS Docker Desktop and Linux rootful Docker are supported policy paths. Running Linux CLI inside WSL is a distinct unvalidated contract.
- `apps/cli/src/services/local-driver.ts` and `local-install.ts`: CLI owns Docker/k3d topology, pinned images, dependency ordering, and jobs. Do not duplicate in Desktop.
- `apps/cli/src/services/local-dashboard.ts`: current dashboard permits localhost or a single-label `.localhost` host.
- `docs/decisions/local-evaluation-cli-auth-and-license-policy.md`: accepted org/EULA and CLI auth/licence policy. Do not bypass its guards.

Required coordinated work includes secure auth/EULA handoff, canonical readiness/licence metadata, and Windows runtime support. Docker Desktop entitlement/distribution terms, pre-auth payload distribution, automatic resources, secure storage, and clean-machine timing remain release gates. They do not prevent implementing the process boundary and honest blocked-state UI now.

## OpenBot integration points

Inspect `desktop/src-tauri/src/{main,install,acquire,windows,preparation,engine,stack,intelligence,vault,host_access}.rs` and `supervisor/src/docker.ts`.

Current code already has pre-auth acquisition, pinned Podman/Compose/Bun downloads, named-VM sizing, nonsecret preparation checkpoints, Docker/Podman contexts, hybrid host/container services, and per-Bot confinement. Windows currently has manual WSL blockers. Existing Desktop auth must not duplicate CLI auth ownership. macOS vault storage currently needs OS-backed replacement; Windows uses DPAPI. Preserve working runtime and supervisor behavior while introducing the agreed architecture.

## Separate research tab

The Podman investigation tab is independent: `Investigate Podman fallback | herring`, terminal `term_012144b4-b37c-4cbb-aa55-a0ac429030bb`. Its files live under `research_notes/Podman fallback investigation/`, including `findings-brief.html`. Read its results if useful; leave ownership of those notes there. Its research is not a prerequisite for primary-path coding.

Older `reports/OpenBot without Docker.md` and `research_notes/OpenBot without Docker/` contain constraints from a broader alternative investigation. The v2 installer artifact overrides their proposed direction.

You own implementation after receiving this brief. The originating agent is handing off, not coordinating a supervised worker. Start by reading the artifact and source, then continue the next tested implementation slice.
