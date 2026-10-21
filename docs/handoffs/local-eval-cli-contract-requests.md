# Local evaluation: contract requests to the Intelligence CLI

From: OpenBot Desktop. To: CopilotKit Intelligence CLI owners. Status: DRAFT, not sent. Date: 2026-10-20.

Source read: Intelligence `main` at `780313e4edf6fc5f038c3cf5e4612ac668446c45` (CLI `copilotkit` 4.29.0; no `apps/cli` changes since `3935afbf`, where this was first read). Paths below are under `apps/cli/` unless they start with `docs/`.

## Summary

1. OpenBot Desktop runs a SHA-256-pinned CLI with fixed arguments only: `local status|start|stop --stack ID --json`, `local list --json`, and `local setup --defer-model --json` in the installation folder. No shell, no `resumeCommand` execution, output bounded. It has no release artifact to pin yet. Verified live against 4.29.0 on Apple silicon: setup (after `accept-terms` in the developer's own terminal), status, stop, start.
2. Version 1 output says a command completed. It does not say Intelligence is ready or licensed, so Desktop reports both as `unknown` and keeps chat closed.
3. Most of the data already exists inside the CLI: a verified licence with `expires_at`, the EULA policy, and a device-code sign-in with JSON events. It is not published as a contract.
4. Windows is rejected in three places, not one.
5. Every field marked PROPOSED is a suggestion. Desktop will not use a flag or field until the CLI ships it.

## Decisions on the Desktop side (2026-10-20)

- **Readiness is required.** Desktop will not start OpenBot from pod observations. It waits for request 2. Until then, local mode stops after Intelligence starts.
- **OpenBot needs its own credential for local Intelligence.** This is new CLI surface: request 8.
- **Tied lifecycle.** A stack that Desktop created for OpenBot starts when OpenBot starts and stops when OpenBot stops or quits. A stack that other apps also use is never stopped by OpenBot. Request 9 asks how to tell the two apart.

## Priority

| # | Request | Blocks Desktop slice |
|---|---|---|
| 1 | Release artifact | Every slice. Nothing can run. |
| 7 | Stdout, exit codes, reason set | Hardens the adapter in use now. Low effort. |
| 2 | Readiness and licence in status | Chat gate and success screen |
| 3 | Non-interactive sign-in | "Sign in with CopilotKit" step |
| 4 | EULA acceptance from a GUI | Licence provisioning after sign-in |
| 5 | Native Windows x64 | All Windows work. Long lead, so start in parallel. |
| 6 | Payloads fetched before sign-in | "Install everything" before sign-in. Release gate. |
| 8 | Credential for OpenBot to local Intelligence | Starting OpenBot against local Intelligence |
| 9 | Stack creation and ownership for Desktop | First run (no stack yet) and tied lifecycle |

## 1. Release artifact for embedding

**Current.** The CLI ships as npm package `copilotkit`, `bin: ./index.js`, `engines.node >=20.9.0` (`package.json`). `oidc-provider` is a runtime dependency and is kept external to the bundle (`esbuild.config.cjs:127`), so `index.js` is not self-contained. `local start` forks a detached sign-in worker with `child_process.fork` (`src/services/local-auth-service.ts:63`), and that worker runs on whatever runtime launched the CLI. Telemetry is on by default. `DO_NOT_TRACK` and `COPILOTKIT_TELEMETRY_DISABLED` turn it off (`src/services/consent/gate.ts:51-78`). With no pinned version, setup takes the newest chart through Helm's stable selection (`src/services/local-default-release.ts:130-136`). We found no code that updates the CLI itself.

**Gap.** There is no per-platform file with a published digest. Bun support is not stated.

**PROPOSED.**
- One archive each for `darwin-arm64` and `win32-x64`, with a published `SHA256SUMS`. It holds either a single executable, or `index.js` plus its `node_modules` and a named runtime version.
- An answer on runtime: is the CLI supported under Bun 1.3.14 (Desktop already bundles it), including `fork` IPC and `oidc-provider`? If not, which Node version should Desktop pin?
- Release builds pin the chart version they were tested with.
- No network self-update at any time.
- A documented list of environment variables that are part of the contract: telemetry opt-out and `HTTPS_PROXY` (`src/services/api-client.ts:589`).
- `copilotkit version --json` → `{ "version": "4.30.0", "chartVersion": "…", "contracts": { "local": 1 } }`.

**Fixture.** Desktop downloads the archive and checks its digest. It runs `version --json` with the network blocked and gets exit 0 with one JSON document.

**Until then.** `installed()` returns `Unavailable`, and the UI shows the CLI as missing.

## 2. Canonical readiness and licence in `local status --json`

**Current.** `local status` emits `stack` (from `describeLocalStack`, `src/services/local-manager.ts:93-111`), `observed` pods (`:126-138`), `auth` `{running,pid,issuer}` and `learning` (`src/commands/local.ts:278-284`). No field gives overall readiness or licence state. The CLI already verifies the licence offline and tolerates `expired` (`src/services/local-license-identity.ts:5-6`). The signed payload carries `expires_at` (see `packages/license-verifier` tests).

**Gap.** Desktop must not read `setup.json` or decode the token itself. It needs these facts from the CLI.

**PROPOSED** (additive top-level fields on `local status`, v1. Desktop treats a missing field as `unknown`):
```json
"readiness": { "state": "ready|starting|stopped|degraded|unknown", "checkedAt": "ISO-8601" },
"license": { "state": "valid|expired|missing|invalid|organization_mismatch",
             "expiresAt": "ISO-8601|null", "organizationId": "string", "organizationName": "string",
             "renewal": "none|pending|applied" }
```
The output never contains a token. `ready` means the CLI's own end-to-end check passed. It does not mean pods are running.

**Fixture.** One fixture per `license.state`. One with `expiresAt` 4 days ahead. One where pods are ready but the API is not, which must give a state other than `ready`.

**Until then.** Both stay `unknown`. Desktop shows a warning when `expiresAt` is 5 days away or less. The person starts renewal with `local renew`. Desktop never renews on its own.

## 3. Non-interactive sign-in

**Current.** `copilotkit login --json` runs a device authorization grant. It streams JSON Lines with `type: action_required` (`authentication_url`, `user_code`, `browser_opened`), then `completed` or `failed` (`src/commands/login.tsx:819, 929-969, 1013`). No secret passes through the caller. The help text says "without opening a browser" (`src/index.ts:252`). The code reports `browser_opened`. Tokens and `clerkOrgId` go in a `conf` file with mode 0600 (`src/services/config.service.ts:33-41`, `src/services/private-conf.ts`). `whoami` prints text only (`src/index.ts:1778-1831`). We found no flag for choosing an organization.

**Gap.** The event schema has no version. The CLI does not use OS secure storage. Choosing an organization is not specified.

**PROPOSED.**
- Make `login --json` a versioned NDJSON contract.
- Say which side opens the browser.
- When the person has several eligible organizations, they choose one in the browser page. The CLI picks one automatically only when exactly one is eligible.
- Add `copilotkit whoami --json` → `{ "signedIn": bool, "organizationId", "organizationName" }`. No tokens.
- Store CLI credentials in macOS Keychain and in Windows Credential Manager/DPAPI, with no plaintext fallback in packaged builds.
- If a loopback or PKCE code is ever needed, it is delivered on stdin. Never in argv or environment variables. (`local auth approve <code>` passes a code in argv today, `src/index.ts:162`.)

**Fixture.** A recorded event stream for each case: single organization, several organizations, expired code, denied.

**Until then.** Desktop does not run `login`. Sign-in is shown as blocked by `authentication_required`.

## 4. EULA acceptance from a GUI

**Current.**
- `onboard local-terms --json` reads `status`, `accepted`, `version`, `url`, `organizationId`, `organizationName` (`src/services/local-eula-terms.ts:30-90`, `src/commands/onboard.ts:1092`). It also returns agent prose: `acceptCommand`, `question`, `next`.
- `local accept-terms` needs a TTY and no detected coding agent (`src/commands/local-accept-terms.ts:74-80`).
- `--accept-eula-version` exists on `setup`, `start` and `renew`, and is documented as "scripts only" (`src/index.ts:166-167`, `src/commands/local-setup.ts:70`).
- Renewal never uses a stored acceptance (`src/services/local-license.ts:115-119`).
- Agent detection walks the process ancestry (`src/services/coding-agent.ts:367`).

**Gap.** There is no GUI route that the policy (`docs/decisions/local-evaluation-cli-auth-and-license-policy.md:91-100`) clearly allows. There is no acceptance receipt.

**PROPOSED.**
- Product owner rules whether a person clicking "Accept" in Desktop counts as the person's acceptance. Desktop's AI bots never get the CLI.
- `local terms --json` (read only) → `{ version, sha256, url, organizationId, organizationName, accepted }`, with no prose.
- `local accept-terms --json --eula-version V --eula-sha256 H` reads `{"accept":true}` on stdin and returns a receipt `{ version, sha256, organizationId, acceptedAt }` recorded by Ops.
- Preferred alternative (2026-10-20): the CLI, not Desktop, records the acceptance. The `blocked` answer for `eula_acceptance_required` carries the approved agreement's address in its existing `nextAction.url` field. That address is an acceptance page, hosted by CopilotKit or served locally by the CLI, where the person reads to the end and clicks Accept, and the acceptance is recorded against the person and selected organization. Desktop opens the page and then runs `local setup` again. Desktop never sends an "accepted" signal, so it cannot accept on the person's behalf. The page enforces reading to the end; Desktop cannot observe scroll position in a page from another site.

**Fixture.** A changed sha256 is refused. An acceptance for a different organization is refused. An agent ancestor is refused.

**Observed live (4.29.0, 2026-10-20).** `local setup --defer-model --json` in a fresh folder exits 2 with `blocked` / `eula_acceptance_required` for version `developer-edition-2026-10-01-web`, and states that an agent must not accept for the developer.

**Until then.** Desktop opens `url` for the person to read and does not accept. Development builds may tell the person to run `local accept-terms` in their own terminal and then Continue; shipped builds may not, because normal setup has no terminal commands.

## 5. Native Windows x64

**Current.**
- `assertLocalPlatform` allows only darwin and linux (`src/services/local-platform.ts:5-9`).
- The Docker Desktop check is darwin-only (`:36-38`).
- The sign-in control socket must be `/tmp/cpki-auth-*/control.sock` (`src/services/local-auth-control.ts:12, 95`).
- Helm and k3d tools map every non-darwin system to `linux` (`src/services/local-default-release.ts:125`).
- The release schema already accepts `win32` (`:26`).

**PROPOSED.**
- Native `win32-x64` CLI on Docker Desktop with the WSL2 backend.
- A named-pipe control channel restricted to the current user by ACL.
- Windows helm/k3d entries in the release metadata.
- Desktop prefers native over a Linux CLI inside WSL: no distro management, no path translation, one credential store.

**Fixture.** `local status --json` on clean Windows 11 x64 returns no `unsupported_platform`.

**Until then.** Windows shows `unsupported_platform` as the CLI reports it.

## 6. Payloads fetched before sign-in

**Current.** Setup order is: platform check (`src/services/local-setup.ts:69`), release lookup (`:127`, an anonymous `helm pull` and `docker buildx imagetools inspect` of `ghcr.io/copilotkit/...`), then licence issuance (`:129`), then tool download (`:158`). We found no registry credential in CLI source.

**Gap.** No command prepares the payloads without a licence. Whether those ghcr packages are public is not stated.

**PROPOSED.**
- Confirm which images and charts are public, and whether any payload is tied to the licence.
- `local prepare --json [--candidate FILE]` → `{ release, chart: { version, sha256 }, images: [{ repository, digest, present }] }`. It creates no stack record and requests no licence.

**Fixture.** Run signed out with the network on, then start with the network blocked. No pull happens.

**Until then.** The image pull happens after sign-in, inside `local setup`.

## 7. Machine-readable output

**Current.**
- `runLocal` catches every error in `--json` mode and prints one JSON line, exiting 0, 1 or 2 (`src/commands/local.ts:94-117`).
- Progress is silent under `--json` (`src/services/local-setup-progress.ts:206-213`).
- Argument errors raised before `runLocal` write to stderr and exit 1 with no JSON (`src/index.ts:1665-1666`).
- Reasons come from two unions (`src/services/local-errors.ts:15, 24`) and from ad hoc literals: `confirmation_required`, `missing_inputs`, `stack_stopped` (on a *completed* renew, `src/commands/local.ts:243`), `approval_not_pending`, `browser_open_failed`, `dashboard_unavailable`.
- `connect`/`cancel` return `blocked` with `nextAction: null` (`:274`).

**PROPOSED.**
- Every `local * --json` writes exactly one JSON document to stdout. This includes argument errors.
- Exit codes are a closed table: 0 completed, 2 blocked, 1 failed.
- An exported, closed `nextAction.reason` enum. A new reason is additive, and blocking unless documented otherwise.
- Changing what an existing reason means requires a version bump.
- `login --json` is documented separately, as NDJSON.

**Fixture.** A golden file for each reason, plus a bad-flag case that must still produce JSON.

**Until then.** An unrecognised reason maps to `Unrecognized` and is treated as blocked (OpenBot Desktop's reason table).

## 8. Credential for OpenBot to call local Intelligence (new surface)

**Current.** OpenBot's hosted path uses a project key (OpenBot Desktop's Intelligence sign-in), and `start_stack` needs an Intelligence API key. `local credentials --json` returns the dashboard address and sign-in commands (`src/commands/local.ts:252-255`), not a key for an app. `local connect` writes `CPK_INTELLIGENCE_API_KEY` into an app folder's `.env` (`:263-266`). Desktop may not read that file.

**Gap.** OpenBot is a bot, not an app folder. It needs a credential for the local stack that the CLI issues and Desktop stores in OS-backed secure storage.

**PROPOSED.** `local bot-credential --stack ID --json` (name open). It writes the credential to stdout once, in a field Desktop reads and never logs, or through protected IPC. It is scoped to that stack, can be revoked, and is listed without its value. Desktop passes it on stdin or through the OS vault, never in argv.

**Fixture.** Issue, list (no value), revoke, and use after revocation, which must fail.

**Until then.** Desktop does not start OpenBot against local Intelligence.

## 9. Stack creation and ownership for Desktop

**Current.**
- `local list --json` returns every recorded stack as `describeLocalStack` output, including `appPaths` (`src/commands/local.ts:166-168`). Desktop now calls it and keeps only the allowlisted stack fields.
- `local setup --json` creates a stack and returns it in a `completed` envelope (`src/commands/local-setup.ts:327`). It needs a signed-in CLI and EULA acceptance (requests 3 and 4).
- Setup binds the stack to the working directory as an app folder (`local-setup.ts:85-90`), which fits a developer's app. Without `--model-config` or `--defer-model` it blocks with `missing_inputs` (`:61`).

**Gap.** Desktop has no app folder to offer, and nothing records that a stack exists only for OpenBot.

**PROPOSED.**
- A supported way to run setup for a bot rather than an app folder, with `--defer-model` (model choice happens in OpenBot).
- An `owner` (or `createdBy`) field on each stack, set at creation and shown in `list`/`status`, so Desktop can tell its own stack from a shared one.

**Fixture.** Setup for OpenBot returns a stack whose owner is OpenBot. A stack created from an app folder shows a different owner.

**Until then.** Desktop can list stacks but does not create one. It treats any stack it did not create as shared and never stops it.

