# Development plan

Roadmap and task breakdown for NexQN AI on top of OpenBot. Phase numbers follow the master prompt;
the content of each phase is adjusted to what the repository actually contains
([repository-analysis.md](repository-analysis.md)). A phase is done when its code, tests and docs
are merged and CI is green — not when it is written up.

## Decisions needed

These change the shape of later phases. Each has a recommendation.

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Where conversation threads and memory live | (a) CopilotKit managed Intelligence; (b) self-hosted Intelligence with a CopilotKit licence; (c) replace Intelligence with a NexQN store | (b) for customers who buy "private"; (a) for development and pilots. (c) is a rewrite of the runtime's thread layer and conflicts with every upstream merge. |
| D2 | Tenancy for release 1 | (a) one deployment per customer; (b) organisations inside one deployment | (a). Organisation isolation touches every table and route; schedule it after release 1 if SaaS is confirmed. |
| D3 | Email/password sign-in | (a) SSO only, as upstream; (b) add Better Auth email/password + reset + invitations | (b) only if SMB customers without an IdP are a target; it needs an outbound mail service. |
| D4 | ChatGPT plan path | (a) keep upstream's private Codex endpoint path; (b) official `codex` CLI only | (b). Required by the NexQN rules against undocumented APIs. |

## Phase status

| Phase | Scope (adjusted) | Status |
| --- | --- | --- |
| 1 Repository analysis | Analysis, architecture, requirements, security, threat model, deployment, upstream strategy | **Done** — `docs/nexqn/` |
| 2 Fork and stabilisation | Remotes, toolchain, baseline checks, CI on the fork, local stack | **Partly done** — see results below |
| 3 White-label branding | NexQN tenant package; extend `brand.yaml` (logo, favicon, colours, URLs); `<title>` from config; replace literal "OpenBot" in copy; NexQN `theme.css` | **In progress** — first increment done (below) |
| 4 Auth and organisations | Map roles; read-only role; invitations; email/password if D3=(b); organisations only if D2=(b) | Not started |
| 5 Model Gateway | `model_providers`, `models` tables; admin screens; test connection; model discovery for Ollama/vLLM/OpenAI-compatible; capability flags; per-Bot model; `usage_records` | Not started |
| 6 Subscription CLI | Accounts, device-code login (Codex), setup-token entry (Claude), vault storage, runs in `agent-computer`, cancel, audit, grants | Not started |
| 7 Agent Builder | Per-Bot model/account/temperature/tools/knowledge; versions; publish; playground with tool-call and timing inspector; templates as tenant `agents/` | Not started |
| 8 Knowledge Base | Tables + pgvector migration; ingestion on `work_items`; parsers in computer; hybrid search; `search_knowledge` tool via gateway; citations | Not started |
| 9 MCP Tool Manager | Already in OpenBot. Remaining: NexQN copy and any gaps found in UAT | Mostly inherited |
| 10 Computer and workspace | Already in OpenBot. Remaining: CLI binaries in the computer image, resource limits per run | Mostly inherited |
| 11 Skills and workflows | Skill versioning; extend Routines/Responsibilities; webhook triggers UI | Mostly inherited |
| 12 Hardening | Security review, load test, restore drill, monitoring, release | Not started |

## Phase 2 baseline results

Machine: Windows 11, Bun 1.4.3 (installed locally for this run, not globally), Node 22, Docker 29.7
(Desktop daemon stopped), an unrelated PostgreSQL already listening on 5432.

| Check | Result |
| --- | --- |
| `git remote -v` | `origin` = TinNVT/nexqn-ai, `upstream` = CopilotKit/OpenBot; `main` = `upstream/main` |
| `bun install --frozen-lockfile` | Pass |
| `bun run format:check` | Pass (2159 files) |
| `bun run lint` | Pass (2187 files, `--error-on-warnings`) |
| `bun run typecheck` | Pass (all workspaces) |
| `bun test` | 9019 pass, 224 fail, 162 errors, 131 skip, 9374 tests across 929 files (725 s). The failures are environmental, not product defects: no PostgreSQL (integration suites refuse at import), Bot sub-workspaces not installed (`web-bot-auth`, `@ag-ui/encoder`, `@mastra/core`, desktop React), computer shell/symlink tests that need a POSIX host, `start.sh` tests, and Windows path separators in `assertion-shape.test.ts`. The Linux CI job (pgvector service, sub-workspace installs, `test:ci` floor) is the authoritative run. |
| `bun run typecheck:tests` | 8 TS6142 errors in `server/tests/headless-components*.test.ts` on this machine, present with and without the Phase 3 changes |
| Local stack (`scripts/start.sh`) | Not run: Docker daemon stopped; Intelligence credentials not provisioned |

CI: `.github/workflows/ci.yml` runs unchanged on the fork; it brings its own pgvector service and
installs the Bot sub-workspaces, so it is the authoritative full-suite run.

Remaining Phase 2 tasks:

1. Start Docker Desktop, provision Intelligence (`bun scripts/setup-learning.ts`), add a model key,
   run `bash scripts/start.sh` with `POSTGRES_PORT` set to a free port.
2. Confirm CI is enabled on `TinNVT/nexqn-ai` and green on `main`.
3. Create a staging `.env` and a staging VPS following [deployment-guide.md](deployment-guide.md).

## Initial task breakdown (Phases 3–6)

### Phase 3 — Branding

Increment 1 (done, tested):

- [x] `examples/nexqn/`: `brand.yaml` (`id: nexqn`, `product_name: NexQN AI`, `short_name: NexQN`,
      `website_url: https://nexqn.vn`), `theme.css` (indigo `#4F46E5` primary, cyan `#06B6D4` chart
      accent, light and dark), General Assistant / Knowledge / Research Bots and channels, skills
      copied from fintech. Selected with `TENANT_PACKAGE_DIR=../examples/nexqn`.
- [x] `brand.yaml` accepts optional `tenant.short_name`, `tenant.website_url` (`https:` only),
      `tenant.support_email`; an older package without them still loads
      (`server/src/tenant-package.ts`).
- [x] `ApplicationConfiguration.brand` and the generated `AppConfig` carry those fields and the
      validated theme (`scripts/generate-app-config.ts`).
- [x] Vite plugin writes `<title>`, `application-name` and the tenant theme into `index.html`
      (`app/src/lib/brand/index-html.ts`, `app/vite.config.ts`); theme selectors raised to
      `html:root` / `html.dark` so they win over the app's own.
- [x] Tests: `server/tests/tenant-package-brand.test.ts` (15), `app/tests/brand-index-html.test.ts`
      (7); updated `server/tests/tenant-package.test.ts` (database suite — runs in CI). Verified with
      a real `vite build` from the NexQN package.

Increment 2 (done, tested, verified in the browser):

- [x] `tenant.logo` / `tenant.favicon` in `brand.yaml`: a plain `.svg`/`.png`/`.webp`/`.ico`
      filename in the package root, at most 128 KB, inlined as a `data:` URI so no package file is
      served from the app's origin (an SVG opened from that origin would run its script there).
      Images are part of the package checksum. NexQN ships `examples/nexqn/logo.svg`.
- [x] Favicon `<link>` in the page shell; logo beside the product name in the sidebar and in place
      of the orb on the sign-in page.
- [x] Every user-facing "OpenBot" in `app/src` (about 70 sentences in 36 files) now reads
      `appConfig.brand.productName`. Deliberately unchanged: the names of other shipped products
      ("OpenBot Recorder", "OpenBot Desktop", "the OpenBot app" on phones), text written for the
      model (`lib/copilot/generative-ui.ts`) and a developer-only error (`main.tsx`).
- [x] Guard test `app/tests/brand-copy.test.ts` fails on any new literal "OpenBot" in app copy, so
      sentences arriving in upstream merges are caught; proven red with a planted literal.
- [x] Self-host banner ("Self-host OpenBot… Talk to an engineer", a CopilotKit sales link): turned
      off with the existing `OPENBOT_SELF_HOST_BANNER=false`; no code needed.
- [x] Tests: `server/tests/tenant-package-brand.test.ts` (23), `app/tests/brand-index-html.test.ts`
      (9), `app/tests/brand-copy.test.ts` (2). Full `app` suite: 2545 pass, 0 failures of its own.

Increment 3 (next):

- [ ] Server messages that reach the browser: about 130 strings in 51 files under `server/src`
      mention "OpenBot". Sort them into copy (use the package's product name), logs, and text for the
      model, which stay as they are.
- [ ] Show `websiteUrl` / `supportEmail` where the app offers help (sign-in, settings).
- [ ] Decide on the extension ("OpenBot Recorder") and desktop app names: renaming them means
      rebuilding and republishing those products under NexQN's own store listings.
- [x] "Powered by CopilotKit · Get a license" is no longer drawn (owner's decision, 2026-11-03).
      Details below.

#### The CopilotKit licence bar

`@copilotkit/react-core` draws a fixed bar, `LicenseWarningBanner` of type `no_license`, whenever
the runtime reports no licence (`status: "none"`) and the browser was given no `publicLicenseKey`.
There is no prop or setting to turn it off, so `patches/@copilotkit%2Freact-core@1.83.0.patch`
(registered in `package.json` `patchedDependencies`, applied by `bun install`) replaces that one
render with `null` in the `.mjs`, `.cjs` and UMD builds. The `expired`, `invalid` and `expiring`
notices are untouched, because they tell an operator something is wrong.
`app/tests/copilotkit-license-banner.test.ts` reads the copy the app resolves and fails if the bar
is drawn again or the other notices disappear.

What this does not change:

- **Licensing.** Both packages are MIT, so the change is allowed by their licence. Hiding the bar
  grants nothing: CopilotKit's Developer Edition is "free for non-production use", and production
  use of Intelligence needs a paid plan. CopilotKit's terms also forbid using its services "to build
  similar or competitive services"; get that reviewed before selling NexQN.
- **Upgrades.** The patch is pinned to 1.83.0. When Renovate or an upstream merge bumps
  `@copilotkit/react-core`, `bun install` refuses the stale patch. Regenerate it with
  `bun patch @copilotkit/react-core@<new>`, edit the same render, `bun patch --commit`, and delete the
  old file.

### Phase 5 — Model Gateway

- [ ] Migration: `model_providers`, `models`, `usage_records`.
- [ ] `server/src/model-gateway/` registry, provider adapters (OpenAI, Anthropic, Gemini,
      OpenAI-compatible incl. Ollama/vLLM), connection test, model list.
- [ ] Admin routes (admin-only, vault credentials) and screens (follow `openbot-screen-layout`,
      `openbot-data-access`).
- [ ] Runtime: resolve a Bot's model from the registry, falling back to the current env behaviour.
- [ ] Tests: adapters against `@copilotkit/aimock`, credential never in responses, capability gate.

### Phase 6 — Subscription CLI

- [ ] Verify current Codex and Claude Code CLI docs; record exact commands in the adapter.
- [ ] Add `codex` and `claude` CLIs to the `agent-computer` image as non-root.
- [ ] Migration: `subscription_accounts`, `subscription_login_sessions`, `subscription_cli_runs`,
      `agent_subscription_grants`.
- [ ] Computer routes: start login, poll status, run, cancel, logout — token-gated, through the gateway.
- [ ] Server module + screens under Settings → AI Accounts.
- [ ] Tests: owner isolation, grant required, token absent from responses/audit/logs, cancel kills
      the process group, timeout.
