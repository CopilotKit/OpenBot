# AgentForce — OpenBot 1.1 handoff

Repo: `https://github.com/DESCASIO/agentforce`  
Branch: `cursor/openbot-1.1-agentforce`  
Started from: CopilotKit OpenBot `upstream/main` at `f75f9911` (package version **1.1.0**)  
Local checkout: `plugiq-agentforce`  
Runtime: **Bun 1.4+** (`packageManager`: `bun@1.4.3`)

This branch is the AgentForce product layer on current OpenBot. It is **not** a replay of the September server fork. Hosted/testing deploy remains on `main` until you deliberately switch; a normal merge of this branch into `main` would conflict across the deleted `server/` tree.

**Do not cut over production until Product Engineer sidecar is proven locally** (ticket → PRs on both `PE_REPOS`). One DevOps cutover after that.

---

## What this tree is

| Piece | Where it lives |
| ----- | -------------- |
| Tenant identity | `examples/fintech/brand.yaml` — `tenant.id: plugiq-agentforce`, `tenant.product_name: PlugiQ AgentForce` |
| Bots / channels / skills | Fintech package + Descasio wording; includes `implement-a-ticket` skill (points people at `/product-engineer`) |
| API + Bot computers | Published image `ghcr.io/copilotkit/openbot:v1.1.0` (pin via `OPENBOT_BACKEND_TAG`) |
| App UI | Built from this checkout (`bun run generate:app-config` reads `brand.yaml`); includes `/product-engineer` |
| Product Engineer | **Sidecar** `product-engineer-sidecar/` + library `product-engineer-loop/` — **not** inside the OpenBot image |

There is **no** in-image mount for PE. Coding credentials stay on the sidecar.

---

## Local (developers)

Needs Docker, Bun **1.4.3**, and a `.env` copied from `.env.example`.

```sh
bun install
bash scripts/start.sh
# In a second terminal, with CURSOR_API_KEY, LINEAR_API_KEY, PE_REPOS set in .env:
bun run dev:pe
bun run dev   # Vite proxies /api/product-engineer → :3020
```

| Service | URL |
| ------- | --- |
| App | http://localhost:3010 |
| API | http://localhost:3001 |
| Product Engineer sidecar | http://localhost:3020/health |

Stop OpenBot: `bash scripts/stop.sh`. Stop PE with Ctrl-C in its terminal.

Compose PE only:

```sh
docker compose --env-file backend-images.env --env-file .env --profile pe up -d product-engineer
```

---

## Deploy image (ECS) — OpenBot

Do **not** `docker build -f Dockerfile` from this checkout for the OpenBot API. The deploy workflow [`.github/workflows/deploy-ecs.yml`](.github/workflows/deploy-ecs.yml):

1. Runs on **push to `main`** (rely on required PR checks before merge)
2. Pulls **`ghcr.io/copilotkit/openbot:v1.1.0`** (`linux/arm64`)
3. Pushes that image to ECR
4. Points the ECS task definition at the ECR **digest**
5. Runs the image `migrate` command, then updates the ECS service

There is **no** LangGraph companion build in this workflow (`LANGGRAPH_*` removed). Risk Analyst stays omitted unless `MANAGED_AGENT_AG_UI_URL` points at a reachable Bot.

Until this branch becomes the default line, hosted/testing continues to follow whatever is on `main`.

---

## Product Engineer sidecar (ECS cutover sketch)

Add a **second** ECS service (or extra container) built from `product-engineer-sidecar/Dockerfile`. Keep the OpenBot task on the published image digest.

| Variable | Notes |
| -------- | ----- |
| `CURSOR_API_KEY` | [cursor.com/dashboard/api](https://cursor.com/dashboard/api) — not Integrations |
| `LINEAR_API_KEY` | Linear API key for ticket intake (separate from Composio) |
| `PE_REPOS` | Comma-separated GitHub URLs (frontend + backend) the Cursor account can access |
| `PE_STARTING_REF` | Optional starting branch/ref |
| `PE_MODEL` | Default `composer-2.5` |
| `PE_SIDECAR_TOKEN` | Recommended in prod; require `Authorization: Bearer …` |
| `PE_RUNS_DIR` | Persist on a volume (`/data/runs`) |

**Ingress:** route `/api/product-engineer/*` to the sidecar (ALB path rule or reverse proxy). The app calls that path same-origin; without the route, PE 404s on the OpenBot container.

**App build:** production must serve an app build from this branch (includes `/product-engineer`). If the fleet only serves the app baked into `ghcr.io/copilotkit/openbot:v1.1.0`, add PE UI via your existing app-dist story or rebuild/serve this checkout’s `app` dist.

**Orgs:** set `OPENBOT_MULTIPLE_ORGANIZATIONS=true` when enabling company signup/invites ([docs/configuration.md](docs/configuration.md)).

**Cutover loss vs September `main`:** custom Documents CRUD and in-process PE/Linear plugins go away; PE returns via this sidecar.

---

## Required env (OpenBot container)

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

## Linear

| Path | Role |
| ---- | ---- |
| **PE sidecar `LINEAR_API_KEY`** | Ticket intake for Product Engineer (required for `/product-engineer`) |
| **Composio Linear** | Chat tools for people who connect Linear under `/connections` |

Composio alone does **not** open multi-repo Cursor PRs.

Full Composio procedure: [docs/plugins/composio.md](docs/plugins/composio.md).

---

## Still not ported from September `main`

- `server/src/plugins/builtin-linear.ts` and its tests (use Composio + PE `LINEAR_API_KEY`)
- Migrations `0040`–`0043`, documents, learning container, browser-identity app patches
- The custom Postgres TLS client
- In-process Bot MCP tools for PE (chat skill `implement-a-ticket` directs to the page; HTTP tools can be added later as a custom MCP on the sidecar)

---

## Pointers

- PE sidecar: [product-engineer-sidecar/README.md](product-engineer-sidecar/README.md)
- Loop / CLI: [product-engineer-loop/README.md](product-engineer-loop/README.md)
- Deployment shape of the published image: [docs/deployment.md](docs/deployment.md)
- Image tag contract: [backend-images.env](backend-images.env)
