# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun install               # install dependencies
bash scripts/start.sh     # start the full stack (Docker + server + app)
bun run dev               # app + server only, no Docker Bots/computers
bun run format:check      # check formatting (Biome)
bun run format            # auto-fix formatting
bun run lint              # lint (Biome, fails on warnings)
bun run typecheck         # typecheck all workspaces
bun run test              # run all tests
bun run build             # build all workspaces
bun run test:smoke        # smoke tests against a running stack
```

Run a single test file:

```sh
bun test server/tests/computer-gateway.test.ts
```

After changing the Drizzle schema:

```sh
bun run --filter server db:generate
bun run --filter server db:migrate
```

CI uses `bun run test:ci` (enforces expected test count on top of normal tests). Run all five quality checks before opening a PR: `format:check`, `lint`, `typecheck`, `test`, `build`.

## Architecture

OpenBot is a monorepo of Bun workspaces: `app` (React/Vite, port 3010), `server` (Hono API, port 3001), and `worker` (background jobs). Docker Compose brings up `agent-computer` (port 4100), `agent-bot` (port 4200), `agent-langgraph` (port 4201), and a `supervisor` (port 4500 host / 4300 container) that creates per-Bot computer containers. PostgreSQL with pgvector runs on 5432. `scripts/start.sh` wires everything together and verifies health routes.

### The gateway is the product boundary

`server/src/computer/gateway.ts` is the only path a Bot action may travel. It does three things in order before any action reaches a computer: (1) resolve the element ref from the server-held DOM snapshot — never from what the model claims it is clicking; (2) evaluate the CEL action policy (deny before allow, fail closed); (3) write an audit row. There is no path that acts without a row existing first. Never bypass the gateway for convenience.

### CopilotKit Intelligence is required

There is no SSE fallback. `server/src/config.ts` refuses to boot without the full Intelligence contract (`INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY`, `COPILOTKIT_LICENSE_TOKEN`). `server/src/copilot.ts` sets up the CopilotKit runtime: package-declared `BuiltInAgent` instances and external Bots as `HttpAgent` over AG-UI.

### Bot identity flows through two tables

`agents` holds runtime identity and endpoint/credential reference. `agent_profiles` holds name, title, role, owner, visibility, and deletion state. A coworker shown in the UI is always a join of both, with membership in `channel_memberships` deciding access to a channel. `users.groups` is currently unpopulated by any sign-in path — group-based channel rules have nothing to evaluate.

### Credential vault

All secrets (model keys, MCP tokens, OAuth clients/tokens, agent auth headers) go through `server/src/credentials.ts`. Credential kinds are a `pgEnum` in `server/src/db/schema/core.ts`. Plaintext is encrypted at rest with `KEY_ENCRYPTION_KEY`, never returned by APIs, and redacted from audit events. The `mcp_oauth_client` kind identifies the deployment to a vendor; `mcp_user_token` is one person's refresh token for one MCP server — different risk profiles, different kinds.

### Tenant package

`TENANT_PACKAGE_DIR` (default `../examples/fintech`) points at a directory of YAML files the server validates at startup: `brand.yaml`, `agents.yaml`, `channels.yaml`, `model.yaml`, `knowledge.yaml`. Channel agent IDs must match declared agents. Bots declared as `built_in` need a credential ref; Bots as `remote_ag_ui` need an endpoint. Never store credential values inline in YAML.

### Migration rules

Never hand-edit a generated migration — if the generated SQL won't work, split it. A data step is its own migration (`bun run --filter server db:generate -- --custom --name=<name>`). Tightening a column (`NOT NULL`) belongs to a later release, not the one that adds it. CI runs `drizzle-kit check` and a generate-and-fail-if-dirty probe.

### Policy engine

`server/src/computer/policy.ts` implements CEL-based action policy. Deny rules are evaluated before allow; a missing or broken rule denies. Policy context attributes a rule may inspect: `tool.name`, `bot.id`, `actor.id`, `page.url`, `page.host`, `element.ref/role/name/type`, `key`, `file.path/name/extension`, `mcp.server/tool/effect`. The shipped default is `deny: []`, `allow: ["true"]`. A malformed `AGENT_COMPUTER_POLICY` stops server startup.

### Components

Compiled React components live in `app/src/components/gallery/` and are published on first sync. Sandboxed components are authored in `/admin/playground` and must be explicitly published. Every component call goes through a server-side check: exists, published, not withheld from that Bot. Component data functions require a separate per-component grant. The shipped data functions (`botActivity`, `recentRefusals`) read the audit trail.

### Auth

`server/src/auth/` — `better-auth` with a Drizzle adapter. Sign-in providers (Google, Microsoft, Okta, plus SAML/OIDC registered at runtime) are configured through env vars; a deployment with none configured refuses to start unless `OPENBOT_SINGLE_USER=true`. `INITIAL_ADMIN_EMAILS` is re-evaluated on every sign-in and cannot be demoted from the People screen. Identity provider client secrets and SAML material are encrypted at rest through a storage adapter wrapper (`KEY_ENCRYPTION_KEY`); OAuth tokens use `BETTER_AUTH_SECRET`.

### App routing

`app/src/routes/` uses TanStack Router. `routeTree.gen.ts` is generated — do not edit by hand. Admin pages are under `_authed/` and backed by server-side administrator checks, not just client-side gating.

## Key env vars

| Variable | Notes |
|---|---|
| `OPENBOT_SINGLE_USER` | One fixed administrator, no sign-in. Required when no IdP is configured. |
| `KEY_ENCRYPTION_KEY` | Base64-encoded 32 bytes. The `.env.example` value is refused with `NODE_ENV=production`. |
| `COMPUTER_TOKEN` | Required by `agent-computer`; every request without it is refused except `/health`. |
| `COMPUTER_SUPERVISOR_URL` | Enables per-Bot computer containers. Without it, all Bots share `AGENT_COMPUTER_URL`. |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | Local development only. |
| `AGENT_TOOL_TOKEN` | Required for a Bot to call granted tools back. Without it no Bot may call tools. |

## Test conventions

Integration tests (files ending `.integration.test.ts`) write to `DATABASE_URL`. Run them against a dedicated database to keep test rows out of a development deployment. Smoke tests (`tests/smoke/`) need a running stack and are skipped by `bun run test`.
