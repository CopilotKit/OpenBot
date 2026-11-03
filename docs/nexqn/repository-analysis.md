# Repository analysis

Phase 1 of NexQN AI. Everything below was checked against the code at upstream commit
`947955a` (CopilotKit/OpenBot `main`, 2026-11-02). Where this document and the code disagree, the
code wins; fix this document.

## 1. Fork state

| Item | State |
| --- | --- |
| `origin` | `https://github.com/TinNVT/nexqn-ai.git` |
| `upstream` | `https://github.com/CopilotKit/OpenBot.git` |
| Divergence | `main` and `upstream/main` are the same commit (0 ahead, 0 behind) at the time of analysis |
| License | MIT, © 2026 CopilotKit (`LICENSE`). Must be kept, and kept in any redistributed image. |
| Package manager | Bun `1.4.3`, pinned in `package.json` (`packageManager`) and in CI |
| History | 632 commits, 76 SQL migrations, ~930 TypeScript test files, 39 Python test files |

## 2. What the repository is

OpenBot is not a prototype. It is a mature, opinionated, self-hostable "AI coworker" platform with
an explicit white-label model ("a template to make your own", `prompt.txt`). The pieces:

| Directory | What it is |
| --- | --- |
| `app/` | React 19 + Vite + TanStack Router/Query. Chat, channels, group chats, Bot profiles, live computer screen, settings, admin. Three alternative "skins" (`app/src/skins/`). |
| `server/` | Hono API on Bun. CopilotKit runtime (AG-UI), Better Auth sign-in, roles, policy gateway, audit, credential vault, MCP/plugins (Composio, Arcade), approvals, routines, responsibilities, memory, delivery (Slack/Teams/SMS/email), voice. Drizzle ORM over PostgreSQL. |
| `worker/` | Routines worker (stand-in for a Kubernetes CronJob). |
| `shared/` | Cross-language provider spec `model-providers.json` + TS/Python loaders. |
| `toolkit/` | `@openbot/toolkit`, shared CopilotKit/agent helpers. |
| `agent-*` | AG-UI Bot harnesses: `agent-bot` (PoC), `agent-langgraph`, `agent-langgraph-agui`, `agent-claude-sdk`, `agent-mastra`, `agent-adk`, `agent-crewai`, `agent-agno`, `agent-ag2`, `agent-llamaindex`, `agent-langroid`, `agent-microsoft`, `agent-pydantic-ai`, `agent-strands`, `agent-antigravity`. |
| `agent-computer/` | The per-Bot computer: Chromium, `/workspace`, file and shell tools, egress filter proxy. |
| `supervisor/` | Creates/stops/resets per-person or per-Bot computer containers through the Docker socket. |
| `desktop/` | Tauri desktop app (bundles a local deployment; model sign-in UI). |
| `mobile/`, `extension/` | Mobile client and the "Recorder" browser extension. |
| `charts/` | Helm chart. |
| `spire/` | Optional SPIFFE/SPIRE attested identity. |
| `examples/fintech` | The default tenant package (branding, Bots, channels, model, skills). |

## 3. Requirement-by-requirement state

Legend: **Done** = implemented and tested upstream. **Partial** = exists but does not meet the
NexQN requirement. **Missing** = not present. **Removed** = existed and was deliberately removed
upstream.

| NexQN requirement | State | Evidence | Action for NexQN |
| --- | --- | --- | --- |
| React/Vite/Hono/Bun/Postgres/Docker/AG-UI/MCP stack | Done | `package.json`, `server/`, `app/`, `docker-compose.yml` | Reuse as is. |
| Centralised branding | Partial | `brand.yaml` → `tenant.id`, `tenant.product_name`, optional `skin.stylesheet` (`server/src/tenant-package.ts`); generated `appConfig.brand` (`scripts/generate-app-config.ts`) is used by sidebar, sign-in, onboarding, skins. Theme CSS restricted to `:root`/`.dark` variables. | Extend `brand.yaml` + `ApplicationConfiguration` with logo, favicon, colours, support email, website (the prompt's `BrandConfig`). `app/index.html` `<title>` is hard-coded "OpenBot"; ~100 app files contain the literal "OpenBot" in user-facing copy. |
| Light/dark theme | Done | `app/src/theme.css`, `.dark` class, inline pre-paint script in `app/index.html` | Reuse; add a NexQN `theme.css`. |
| Tenant `theme.css` reaching the browser | **Upstream gap** | `loadTenantPackage` reads and validates `theme.css`, but nothing passed it to the app: a package theme changed nothing on screen. | Fixed in Phase 3: the validated theme is written into `index.html` at build time (`app/src/lib/brand/index-html.ts`). |
| Sign-in (Google/Microsoft/Okta, SAML/OIDC by domain), sessions, SCIM | Done | `server/src/auth/*`, Better Auth, `sso_providers`, `scim_*` tables | Reuse. |
| Email/password registration, password reset | Missing | Sign-in is IdP-only, or `OPENBOT_SINGLE_USER=true` | Decide (see §6). |
| Roles | Partial | `role` enum is `admin` / `user` only (`server/src/db/schema/core.ts:29`, `server/src/auth/roles.ts`) | Map NexQN roles onto this; add read-only and owner later only if needed. |
| Organisations / multi-tenant | Missing by design | One deployment = one tenant package. `server/src/auth/organization.ts` is CopilotKit organisation *sign-in*, not tenancy. No `organization_id` column anywhere. | Large change. Recommend deployment-per-tenant first (§6). |
| Model providers | Partial | Env-configured: OpenAI, Anthropic, Google, plus any OpenAI-compatible endpoint via `OPENAI_BASE_URL` (covers Ollama, vLLM, LM Studio, gateways). `shared/model-providers.json`, `model.yaml`. Startup probe `server/src/model-availability-check.ts`. Usage table `model_usage` records model + allowed only, no tokens. | Build an admin Model Provider registry (DB-backed, vault credentials) on top of the existing provider spec. |
| Local models (Ollama/vLLM) | Partial | Works through `OPENAI_BASE_URL`, one endpoint for the whole deployment | Per-provider endpoints + capability flags. |
| Claude subscription | Partial | `agent-claude-sdk` accepts `CLAUDE_CODE_OAUTH_TOKEN` from the official `claude setup-token`; `server/src/agents/plan-model.ts` routes built-in Bots through it. One token per deployment, set in env or by the desktop app. | Per-user accounts, vault storage, remote login flow. |
| ChatGPT subscription | Partial, **non-compliant with NexQN rules** | `agent-langgraph-agui/src/main.py` reads a Codex `auth.json` (`CHATGPT_AUTH_FILE`) and calls `chatgpt.com/backend-api/codex` through `langchain_openai.chat_models.codex._ChatOpenAICodex`, which the code itself calls "private and experimental". | NexQN must not ship this path. Drive the official `codex` CLI (`codex exec`) as a subprocess instead (§5). |
| Agent builder | Partial | Bots are created in the app (`app/src/components/agents/new-bot-sheet.tsx`), profiles in `agent_profiles`, per-Bot setup/access/sharing/skills pages; tenant package declares Bots in YAML. No versioning, no publish workflow, no playground with execution inspector, no per-Bot model/temperature. | Extend existing Bot profile rather than a parallel "Agent" entity. |
| Knowledge base / RAG | **Removed** | Migration `0010_drop_the_document_index.sql` dropped `documents`, `chunks`, `document_acls` and the `vector` extension usage. `knowledge.yaml` is validated and read by nothing. Upstream's position: answer from the vendor (Drive/Notion) at question time, as the asking person. | New module. Must reintroduce pgvector deliberately and design per-person ACLs, since upstream removed the old index for answering "as the deployment". |
| MCP tool manager | Done | `mcp_servers`, `mcp_tools`, `mcp_user_credentials`, `plugin_grants`; admin pages `admin/plugins/*`; URL checks; read/write classification; per-tool grants; OAuth per user | Reuse. Add NexQN UI polish only. |
| Allow / deny / require approval | Done | Action policy (CEL rules, fail closed) `action_policy`; approvals `approval_rules`, `approval_requests`, `server/src/approvals/*` | Reuse. |
| Policy gateway for all tool calls | Done | `docs/architecture.md` "Browser action governance"; MCP path checks grant → policy → audit | Reuse; every new tool type must go through it. |
| Audit log | Done | `audit_events` (append-only by trigger, migration `0012`), CSV export, initiator column, retention window | Reuse. |
| Credential vault | Done | AES-GCM envelopes keyed on `KEY_ENCRYPTION_KEY` (`server/src/credentials.ts`), never returned by APIs, redacted from audit | Reuse for provider keys and subscription tokens. |
| Browser computer & isolation | Done | `agent-computer/`, `supervisor/`, per-person/per-Bot containers, egress policy, gVisor option, separate Docker networks | Reuse. CLI execution should run inside this computer, not on the API host. |
| Skills | Done | `skills`, `skill_tools`, `skills.yaml`, skill-creator flow, tool narrowing | Reuse; add versioning later. |
| Workflows / scheduling | Partial | Routines (cron, `routines`, `work_items` queue), Responsibilities (triggers), inbound email triggers, webhooks (`webhook_subscriptions`) | Extend; do not build a separate engine. |
| Redis / job queue | Not needed | Durable work uses PostgreSQL `work_items` with `skip locked` leases | Do not add Redis without a measured reason. |
| Observability | Partial | OpenTelemetry export, audit, `model_usage` | Add usage records distinguishing API / CLI / local. |
| Docker Compose | Done | `docker-compose.yml`, `Dockerfile` (one-container image), healthchecks, `data`/`default` networks | Reuse; add NexQN overrides. |
| Helm | Done | `charts/openbot` | Not required by NexQN; keep. |
| CI | Done | `.github/workflows/ci.yml`: format/lint/types, real-browser tests, chart, tests with pgvector, migrations, image build, Python harness tests, zizmor | Reuse unchanged on the fork. |

## 4. External dependency that decides "private"

`INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL` and an Intelligence API key are **required**
— the server refuses to start without them (`docs/configuration.md`, "Required API server
variables"). CopilotKit Intelligence holds conversation threads, memory and the realtime gateway.
It is either CopilotKit's managed service or a self-hosted instance with a CopilotKit licence.

For a product sold as a *private* AI platform this is the single largest architectural fact in the
repository: conversation content leaves the deployment unless Intelligence is self-hosted. This is
an owner decision, recorded in [development-plan.md](development-plan.md#decisions-needed).

## 5. Subscription CLI providers — what the official tools support

From the vendors' published documentation (verify again before implementation):

| | Claude Code | OpenAI Codex CLI |
| --- | --- | --- |
| Headless run | `claude -p "<prompt>"` with `--output-format stream-json` | `codex exec "<prompt>"` with `--json` |
| Login on a remote box | `claude setup-token` prints a long-lived OAuth token for a Pro/Max plan, used as `CLAUDE_CODE_OAUTH_TOKEN` | `codex login --device-auth` (device-code flow), credentials in `$CODEX_HOME/auth.json` |
| Status / logout | `claude` reports auth state; token revoked from the account | `codex login status`, `codex logout` |

Design consequence: each connected account gets its own `CODEX_HOME` / token, stored encrypted in
the vault, materialised only inside the user's computer container for the duration of a run, never
on the API host and never in the browser. Running the CLI inside `agent-computer` reuses the
existing isolation, egress policy, workspace and audit path.

## 6. Customization map

Where NexQN changes go, so upstream merges stay cheap.

| Concern | Extension point | Touch upstream files? |
| --- | --- | --- |
| Name, theme, Bots, channels, skills | Tenant package `examples/nexqn/` selected by `TENANT_PACKAGE_DIR` (under `examples/` so the existing Dockerfiles copy it) | No |
| Logo, favicon, colours, URLs | Extend `brand.yaml` schema in `server/src/tenant-package.ts` and `ApplicationConfiguration` | Yes, small, additive (candidate to upstream) |
| `<title>`, meta | Generate from `appConfig` at build (Vite `transformIndexHtml`) | Yes, small |
| Literal "OpenBot" in copy | Replace with `appConfig.brand.productName` | Yes, many files; do in one mechanical commit; candidate to upstream |
| Model provider registry | New `server/src/model-gateway/` + new tables | Additive |
| Subscription accounts | New `server/src/subscription-cli/` + adapter running in `agent-computer` | Additive, plus a new tool route on the computer |
| Knowledge base | New `server/src/knowledge/` + migration re-adding `vector` | Additive |
| Organisations | Cross-cutting | Yes, everywhere — defer (see plan) |
| Docs | `docs/nexqn/` | No (upstream `docs/` left untouched) |

## 7. Phase 2 baseline (this machine, Windows 11)

| Check | Result |
| --- | --- |
| `bun install --frozen-lockfile` (Bun 1.4.3) | OK, 1217 packages |
| `bun run format:check` | OK, 2159 files |
| `bun run lint` | OK, 2187 files, no warnings |
| `bun run typecheck` | OK, all workspaces |
| `bun test` (no database, no sub-workspace installs) | 9019 pass, 224 fail, 162 errors, 131 skip across 929 files; failures are environmental, see [development-plan.md](development-plan.md#phase-2-baseline-results) |
| Run the application | Not run: Docker Desktop daemon was stopped, and the server requires Intelligence credentials that are not configured |
