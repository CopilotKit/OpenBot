# AgentForce — build and run

Repo: `https://github.com/DESCASIO/agentforce`  
Local checkout: `plugiq-agentforce`  
Runtime: **Bun 1.3+**. One container image for deploy.

---

## Local (developers)

Needs Docker, Bun, and a `.env` copied from `.env.example`.

```sh
bun install
bash scripts/start.sh
```

| Service | URL                   |
| ------- | --------------------- |
| App     | http://localhost:3010 |
| API     | http://localhost:3001 |

Stop: `bash scripts/stop.sh`

App + API only (no Docker bots/computers):

```sh
bun run dev
```

---

## Build

From the repo root:

```sh
bun install
bun run build
```

Deployable image (this is the one to ship):

```sh
docker build -t agentforce .
```

Published upstream image (if you are not building our tree): `ghcr.io/copilotkit/openbot` — **linux/amd64 only**. For our fork, build from this repo and push to our registry.

---

## Run the container

One process, **port 3001**. Pass the same env you would use locally.

```sh
# External Postgres (preferred)
docker run -p 3001:3001 --env-file .env agentforce

# Or Postgres inside the container
docker run -p 3001:3001 --env-file .env \
  -e EMBEDDED_POSTGRES=on \
  -v agentforce-data:/var/lib/postgresql \
  agentforce
```

Mount `/var/lib/postgresql` (the parent), not `/var/lib/postgresql/data`.

Migrations, external DB (do this as a release step, not at API start):

```sh
docker run --rm --env-file .env --entrypoint sh agentforce \
  -c "cd /app/server && bun scripts/migrate.ts"
```

`--entrypoint sh` is required. Without it the image boots the whole server, then migrates.

---

## Env the container will not start without

| Variable                                                                      | Notes                                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`                                                                | Postgres with the `vector` extension. Skip if `EMBEDDED_POSTGRES=on` |
| `KEY_ENCRYPTION_KEY`                                                          | `openssl rand -base64 32`. The example key is refused in production  |
| `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY` | CopilotKit Intelligence (`cpk-...` key)                              |
| `OPENAI_API_KEY`                                                              | or whichever model provider you configured                           |
| Auth                                                                          | Google / Microsoft / Okta **or** `OPENBOT_SINGLE_USER=true`          |

We are currently running **without OAuth**: `OPENBOT_SINGLE_USER=true`. Put TLS in front of any shared URL.

Leave `MANAGED_AGENT_AG_UI_URL` unset in the container unless a Bot is actually reachable from it. The laptop default `http://localhost:4201/ag-ui` will break a deploy.

---

## What is not in the image

- **Supervisor** (per-Bot computers). Needs a Docker socket. Without it, every Bot shares one browser.
- **Routines worker.** Schedule `bun scripts/fire-routines.ts` from `/app/server` (same env + `SERVER_INTERNAL_URL` and `WORKER_SHARED_SECRET`).
- **Staged-attachment sweep.** Schedule `bun scripts/cull-staged-attachments.ts` from `/app/server` (needs `DATABASE_URL` only). Helm runs this hourly.

Kubernetes: Helm chart is `charts/openbot/`. Full notes: `docs/deployment.md`.

**Size:** 2 GB RAM minimum, 4 GB recommended. Do not set shared memory; Chromium uses `/tmp`.
