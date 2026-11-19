# AgentForce — OpenBot 1.1 handoff

Repo: `https://github.com/DESCASIO/agentforce`  
Branch: `cursor/openbot-1.1-agentforce`  
Started from: CopilotKit OpenBot `upstream/main` at `f75f9911` (package version **1.1.0**)  
Local checkout: `plugiq-agentforce`  
Runtime: **Bun 1.4+** (`packageManager`: `bun@1.4.3`)

This branch is the AgentForce product layer on current OpenBot. It is **not** a replay of the September server fork. Hosted/testing deploy remains on `main` until you deliberately switch; a normal merge of this branch into `main` would conflict across the deleted `server/` tree.

---

## What this tree is

| Piece | Where it lives |
| ----- | -------------- |
| Tenant identity | `examples/fintech/brand.yaml` — `tenant.id: plugiq-agentforce`, `tenant.product_name: PlugiQ AgentForce` |
| Bots / channels / skills | Upstream fintech package with Descasio wording; no `developer` bot, no `engineering` channel, no `linear-tickets` / `implement-a-ticket` |
| API + Bot computers | Published image `ghcr.io/copilotkit/openbot:v1.1.0` (pin via `OPENBOT_BACKEND_TAG`) |
| App UI | Built from this checkout (`bun run generate:app-config` reads `brand.yaml`) |

There is **no** `server/` directory in this tree. Do not look for `server/src/db/postgres-js.ts`, custom Linear plugins, or Product Engineer routes here.

---

## Local (developers)

Needs Docker, Bun **1.4.3**, and a `.env` copied from `.env.example`.

```sh
bun install
bash scripts/start.sh
```

| Service | URL |
| ------- | --- |
| App | http://localhost:3010 |
| API | http://localhost:3001 |

Stop: `bash scripts/stop.sh`

App only (API still from the published image via Compose):

```sh
bun run dev
```

Images are pulled at the tag in `backend-images.env` (`OPENBOT_BACKEND_TAG`). Override with `OPENBOT_BACKEND_TAG=v1.1.0` in the environment or `.env` to match the ECS pin. Compose by hand:

```sh
docker compose --env-file backend-images.env --env-file .env up -d
```

---

## Deploy image (ECS)

Do **not** `docker build -f Dockerfile` from this checkout for production. The deploy workflow [`.github/workflows/deploy-ecs.yml`](.github/workflows/deploy-ecs.yml):

1. Waits for **CI** success on **`main`** (`workflow_run`)
2. Pulls **`ghcr.io/copilotkit/openbot:v1.1.0`** (`linux/arm64`)
3. Pushes that image to ECR
4. Points the ECS task definition at the ECR **digest**
5. Runs the image `migrate` command, then updates the ECS service

There is **no** LangGraph companion build in this workflow (`LANGGRAPH_*` removed). Risk Analyst stays omitted unless `MANAGED_AGENT_AG_UI_URL` points at a reachable Bot.

Until this branch becomes the default line, hosted/testing continues to follow whatever is on `main`.

---

## Required env (container)

| Variable | Notes |
| -------- | ----- |
| `DATABASE_URL` | Postgres. Prefer `?sslmode=require` for RDS/managed DB. Use the published image’s own DB client — **do not** port the September `postgres-js.ts` TLS fork. Skip if `EMBEDDED_POSTGRES=on`. |
| `KEY_ENCRYPTION_KEY` | `openssl rand -base64 32`. Example key refused in production |
| `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, Intelligence key | CopilotKit Intelligence (`CPK_INTELLIGENCE_API_KEY` / legacy `INTELLIGENCE_API_KEY`) |
| Model key | e.g. `OPENAI_API_KEY` |
| Auth | Google / Microsoft / Okta **or** `OPENBOT_SINGLE_USER=true` |

Leave `MANAGED_AGENT_AG_UI_URL` unset unless a Bot is reachable from the container.

Migrations: the published server applies schema changes when it starts; the ECS job also runs `migrate` as a release step.

---

## Linear (Composio — not the September plugin)

Linear is **not** wired through `server/src/plugins/builtin-linear.ts` or `LINEAR_API_KEY` package grants on this branch.

Use Composio:

1. Set `COMPOSIO_API_KEY` (or run `bun run setup:composio` locally)
2. Enable Linear under `/admin/plugins/composio`
3. Grant Linear actions to the Bots that need them
4. Each person connects their Linear account at `/connections`

Full procedure: [docs/plugins/composio.md](docs/plugins/composio.md).

---

## Not in this migration

These stay on the September fork (`main` / older AgentForce commits) and are **not** ported:

- `server/src/plugins/builtin-linear.ts` and its tests
- `server/src/product-engineer/` and `product-engineer-loop/`
- Migrations `0040`–`0043`, documents, learning container, browser-identity app patches
- The custom Postgres TLS client
- Anthropic version-header harness work on `cursor/anthropic-version-header`

**Product Engineer:** OpenBot 1.1 has no route to mount `product-engineer-loop`. Do not expect implement-a-ticket or PE env (`CURSOR_API_KEY`, `PE_REPOS`, package `LINEAR_API_KEY` seeding) on this branch.

---

## Pointers

- Deployment shape of the published image: [docs/deployment.md](docs/deployment.md)
- Image tag contract: [backend-images.env](backend-images.env)
- Kubernetes: Helm notes under `docs/` / chart README shipped with OpenBot
