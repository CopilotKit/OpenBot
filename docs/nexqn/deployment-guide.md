# Deployment guide

NexQN AI deploys the way OpenBot does. This guide is the NexQN operator's path; the upstream
reference is [../deployment.md](../deployment.md) and [../development.md](../development.md).

## Prerequisites

- Ubuntu 22.04/24.04 VPS, 4 vCPU / 8 GB RAM minimum (each Bot computer runs Chromium), Docker
  Engine with the Compose plugin. No GPU and no Kubernetes required.
- A domain pointing at the VPS (directly, or proxied through Cloudflare).
- CopilotKit Intelligence: managed project, or a self-hosted instance with a licence. The server
  will not start without it (see [repository-analysis.md](repository-analysis.md#4-external-dependency-that-decides-private)).
- An identity provider (Google, Microsoft, Okta, SAML or OIDC). `OPENBOT_SINGLE_USER=true` is only
  for a private network; the server refuses it on a public address.

## Local development (Windows, macOS, Linux)

```sh
cp .env.example .env
bun install            # Bun 1.4.3, the version pinned in package.json
bun run format:check && bun run lint && bun run typecheck
bun test
```

### Ports

NexQN runs every host port in the 5000s. Upstream's defaults (3001, 3010, 4100…) stay in the
code; the NexQN ports are settings, which `docker-compose.yml`, `scripts/start.sh` and the server
all read, so no upstream file changes. Put this block in `.env`:

```sh
PORT=5001                 # same value as SERVER_PORT, or the server refuses to start
SERVER_PORT=5001          # API server
APP_PORT=5010             # web app (open http://localhost:5010)
COMPUTER_PORT=5100        # agent-computer
BOT_PORT=5200             # agent-bot
LANGGRAPH_PORT=5201       # agent-langgraph
PICKED_HARNESS_PORT=5202  # the harness picked in setup
SUPERVISOR_PORT=5500      # supervisor (host side; 4300 inside its container is unchanged)
POSTGRES_PORT=55432       # 5432 is often taken by a local PostgreSQL
DATABASE_URL=postgres://openbot:openbot@localhost:55432/openbot
AGENT_COMPUTER_URL=http://localhost:5100
TRUSTED_ORIGINS=http://localhost:5010,http://127.0.0.1:5010
```

The URL settings do not follow the ports by themselves, which is why `DATABASE_URL`,
`AGENT_COMPUTER_URL` and `TRUSTED_ORIGINS` are in the block. `start.sh` builds the managed Bot and
supervisor addresses from the ports. Container-internal ports (4100 inside the computer image,
4300 inside the supervisor) are not published and stay as they are.

The Vite dev server does not read the root `.env` on its own (`start.sh` exports `APP_PORT` and
`SERVER_PORT` for it). Started any other way, give it the file: `bun --env-file=../.env --bun
node_modules/vite/bin/vite.js` from `app/`, or it serves on 3010 and proxies the API to 3001.

Full stack (needs Docker running, Intelligence credentials and a model key in `.env`):

```sh
bash scripts/start.sh
```

Keep `TENANT_PACKAGE_DIR` at the default package in `.env` and select NexQN in the process
environment when running the app (`TENANT_PACKAGE_DIR=../examples/nexqn`, which wins over
`--env-file`). Upstream's tests read copy built from the default package, whose product is called
OpenBot, so a `.env` pointing at NexQN makes them fail locally for no real reason. Integration tests
need `TEST_DATABASE_URL` pointing at a separate database (for example `openbot_test`), never the
development one.

`bun test`, `bun run typecheck` and `bun run build` each regenerate
`app/src/lib/generated/application-config.ts` from `.env` first. A dev server already running picks
that file up, so after running them the open app shows the default package's name until you restart
it with `TENANT_PACKAGE_DIR=../examples/nexqn`.

Windows notes from the Phase 2 baseline: `start.sh` needs a POSIX shell with `lsof` and `openssl`
(Git Bash or WSL); if another PostgreSQL already listens on 5432, set `POSTGRES_PORT` (read by
`docker-compose.yml`) and the port in `DATABASE_URL` to a free one.

## Production on a VPS

1. Clone the NexQN repository on the VPS and check out a release tag.
2. `cp .env.example .env` and set at least:
   - `KEY_ENCRYPTION_KEY=$(openssl rand -base64 32)` — store a copy outside the server.
   - `BETTER_AUTH_SECRET`, `COMPUTER_TOKEN`, supervisor and managed-agent tokens: long random values.
   - `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY`.
   - Identity provider variables and `INITIAL_ADMIN_EMAILS`.
   - `OPENBOT_PUBLIC_URL` / `OPENBOT_APP_URL` / `TRUSTED_ORIGINS` = your HTTPS origin.
   - `TENANT_PACKAGE_DIR=../examples/nexqn` (the NexQN tenant package; resolved from `server/`,
     and already copied into the images, which copy all of `examples/`). The app's title and theme
     are written in at build time from this package, so set it before `bun run build` / image build.
   - `NODE_ENV=production`.
   - The compose PostgreSQL ships with `openbot`/`openbot`; it is bound to loopback and on its own
     `data` network, but change the password for production all the same.
   - Leave `CHATGPT_AUTH_FILE` unset (see [security-architecture.md](security-architecture.md)).
   - `OPENBOT_SELF_HOST_BANNER=false`, which hides CopilotKit's "Self-host OpenBot / Talk to an
     engineer" bar from NexQN's users.
3. Start the stack with Docker Compose. Keep `agent-computer` (5100) and `supervisor` (5500) bound
   to `127.0.0.1` as the compose file already does; publish only the app/API port through the
   reverse proxy.
4. Put Nginx (or Cloudflare Tunnel) in front:

   ```nginx
   server {
     listen 443 ssl http2;
     server_name ai.example.com;
     ssl_certificate     /etc/letsencrypt/live/ai.example.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/ai.example.com/privkey.pem;
     client_max_body_size 50m;

     location / {
       proxy_pass http://127.0.0.1:5001;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;      # live screen and streaming use websockets
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto https;
       proxy_read_timeout 3600s;                    # long agent runs stream for minutes
       proxy_buffering off;
     }
   }
   ```

   Certificates: `certbot --nginx -d ai.example.com`. With Cloudflare, use Full (strict) TLS mode
   and keep websockets enabled.
5. Schedule the sweeps that the single-container image does not run itself: routines
   (`bun scripts/fire-routines.ts`) and staged attachments (`bun scripts/cull-staged-attachments.ts`),
   as described in the upstream deployment doc. The compose `worker` service covers routines.

## Local models

Ollama on the same host:

```sh
docker run -d --name ollama -p 127.0.0.1:11434:11434 -v ollama:/root/.ollama ollama/ollama
docker exec ollama ollama pull <model>   # explicit; nothing is pulled automatically
```

Until the Phase 5 provider registry exists, point the deployment at it with
`OPENAI_BASE_URL=http://ollama:11434/v1` (inside the compose network) and a model that supports
tool calling, or Bots cannot drive their computer. vLLM is the same with its `/v1` URL.

## Backup and restore

What must be backed up together: the PostgreSQL database **and** `KEY_ENCRYPTION_KEY`. Without the
key, every stored credential in the backup is unreadable.

```sh
# Backup (compose service name: postgres)
docker compose exec -T postgres pg_dump -U openbot -Fc openbot > nexqn-$(date +%F).dump

# Restore into an empty database
docker compose exec -T postgres pg_restore -U openbot -d openbot --clean --if-exists < nexqn-YYYY-MM-DD.dump
```

`audit_events` is append-only by trigger; `pg_restore --clean` into a database that already holds
rows will be refused for that table — restore into a fresh database. Computer volumes
(`agent-workspace`, `agent-profiles`) hold browser logins and files; back them up if those matter.
Test a restore on a separate machine before relying on it.

## Upgrades

Database migrations run through the `migrate` compose service (`bun scripts/migrate.ts`), which
refuses a database stamped newer than the code. Back up, pull the new tag, `docker compose up -d`.
