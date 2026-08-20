# Deployment

OpenBot ships as one container. It carries the app, the API that serves it, and the browser the Bots
drive. Point it at a PostgreSQL database and it does what it does on a laptop.

```sh
docker build -t openbot .
docker run -p 3001:3001 --env-file .env openbot
```

## What is in the image, and what is not

**In it:** the built app, the API, and Chromium. One port, 3001. The browser listens on 4100 inside
the container and is deliberately not published: it holds real logins and its only caller is the
process beside it.

**Not in it:**

**PostgreSQL.** A container filesystem does not survive a redeploy and the audit trail is the
product. Point `DATABASE_URL` at a managed instance. The `vector` extension must be enabled; RDS,
Cloud SQL and Azure Database all support it, none enable it for you.

**The supervisor.** It gives each Bot its own container, which needs a Docker socket, which no
serverless container platform permits. Without it every Bot shares the one browser, exactly as they
do on a laptop with no supervisor configured. A shared browser means shared logins, shared files and
shared session between Bots, which is fine for a deployment where one team trusts its own Bots and
is not fine as a boundary between tenants.

## Minimum size

Measured on the real image, one Bot, arm64.

| | Measured | Minimum | Recommended |
| --- | --- | --- | --- |
| Memory | 409 MB idle, 498 MB after three page loads, 548 MB after a snapshot | **2 GB** | **4 GB** |
| vCPU | 3 to 6 percent at rest, bursty while a page renders | **1** | **2** |
| Disk | 5.3 GB image | **8 GB** | 10 GB with room for `/workspace` |

**Why 2 GB when it measures at 550 MB.** That figure is one Bot with one page open. Every additional
concurrent page is roughly another 100 to 200 MB, and Playwright's own guidance is to allow about
1 GB per concurrent browser. 2 GB is the floor at which one person using it does not meet the OOM
killer; 4 GB is where a handful of Bots working at once stays comfortable.

**Do not configure shared memory.** Chromium is launched with `--disable-dev-shm-usage`, so it writes
to `/tmp` rather than `/dev/shm` and the 64 MB default is irrelevant. This matters because **AWS
Fargate does not support `sharedMemorySize` at all**; without that flag Chromium would crash there
and the fix would not be available.

## Required configuration

| Variable | |
| --- | --- |
| `DATABASE_URL` | PostgreSQL with the `vector` extension |
| `KEY_ENCRYPTION_KEY` | base64 32 bytes. `openssl rand -base64 32`. The example key is refused in production |
| `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY` | CopilotKit Intelligence. A free plan is available and it can be self-hosted |
| `COPILOTKIT_LICENSE_TOKEN` | from `npx copilotkit@latest license --write` |
| `MANAGED_AGENT_AG_UI_URL` | the AG-UI endpoint for the example remote Bot |
| a model key | `OPENAI_API_KEY`, or the provider you configured |

`COMPUTER_TOKEN` is generated at start if you do not set one. Both processes that need it are inside
the container, so there is nothing to share it with.

**Authentication is required.** `OPENBOT_DEV_NO_AUTH` is refused when `NODE_ENV=production`, which
the image sets. A deployment anybody can reach needs Google sign-in configured, or every visitor is
an administrator.

## Migrations

A release step, not a start step. Two replicas starting together would race, and a failed migration
should stop a deploy rather than leave a half-migrated database serving traffic.

```sh
docker run --rm --env-file .env openbot \
  sh -c "cd /app/server && bun x drizzle-kit migrate --config=drizzle.config.ts"
```

## One replica, for now

Run one. The gateway still caches the page snapshot a Bot resolves element references against in
process memory, so a second replica answers a click with a snapshot it never took. The symptom is an
element that cannot be found, intermittently, which reads as a flaky Bot rather than as a
configuration problem. Pin the platform's maximum instance count until that moves to the database.

## Platform notes

**Google Cloud Run.** Set memory to at least 2 GB and max instances to 1. Cloud Run runs every
container under gVisor, which Chromium is sensitive to; test a navigation before trusting it.
`gcloud run compose up` will also deploy the whole compose file if you want a throwaway database
alongside.

**AWS.** ECS Express Mode provisions the cluster, load balancer, HTTPS and autoscaling from an image
in ECR, and is what AWS points App Runner users at now that App Runner takes no new customers.
Plain ECS on Fargate behind an ALB is the answer if you want task definitions and fine-grained IAM.
No shared-memory configuration is needed or possible.

**Azure Container Apps.** Managed ingress with TLS and custom domains. Note the **240 second request
timeout**: the live screen holds a long connection, so expect it to reconnect. Concurrent WebSockets
are capped at 350 per instance on the basic tier.

**Railway, Render, Fly.io.** All run this image directly and all provision PostgreSQL in a click,
which makes them the shortest path from nothing to a running deployment.

## Known costs

**The image is 5.3 GB**, most of it the Playwright base, which ships Firefox and WebKit alongside the
Chromium we use. Deleting them afterwards does not help, because the bytes still ship in the layer
below. Building Chromium-only onto a slim base would cut this substantially and is not done yet.
