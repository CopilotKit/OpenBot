# Deployment

OpenBot ships as one container. It carries the app, the API that serves it, and the browser the Bots
drive, and it can carry its own PostgreSQL as well. It does what it does on a laptop.

```sh
# Every release publishes this image, so a deployment needs no clone and no build.
# `latest` is the most recent; a version tag such as `:v1.0.1` pins one.
image=ghcr.io/copilotkit/openbot:latest

# A database you already run.
docker run -p 3001:3001 --env-file .env "$image"

# Or one inside the container. Nothing else to provision.
docker run -p 3001:3001 --env-file .env \
  -e EMBEDDED_POSTGRES=on -v openbot-data:/var/lib/postgresql "$image"
```

The image is published, and a deployment pulls it; this tree does not build it. What a release
publishes is digest-pinned in its `container-images.json`, and deploying those digests rather than a
moving tag is what [releasing.md](releasing.md) recommends.

## Checking an image's signature

OpenBot's images are signed with OpenBot's own key. The public half is [cosign.pub](cosign.pub), and
[cosign](https://docs.sigstore.dev/cosign/) checks an image against it before you deploy:

```sh
cosign verify --key docs/cosign.pub --insecure-ignore-tlog=true ghcr.io/copilotkit/openbot-server:main
```

The same command checks `ghcr.io/copilotkit/openbot`, `openbot-agent-computer` and
`openbot-supervisor`, at any tag published from now on; images from v1.0.2 and earlier carry no
signature. The signatures are not recorded in a public transparency log, which is what
`--insecure-ignore-tlog=true` tells cosign to expect. The key is what proves the image is OpenBot's.

## What is in the image, and what is not

**In it:** the built app, the API, and Chromium. One port, 3001. The browser listens on 4100 inside
the container and is deliberately not published: it holds real logins and its only caller is the
process beside it.

**PostgreSQL, if you ask for it.** `EMBEDDED_POSTGRES=on` starts one inside the container, creates
the database and the `vector` extension the first time, and runs the migrations on every start. It
listens on loopback only and is never published, so there is no password to manage.

Give it a volume at `/var/lib/postgresql` — the parent, not the data directory itself. Without one,
a redeploy takes the audit trail with it, and the audit trail is the product.

**Mount the parent, not `/var/lib/postgresql/data`.** On any platform whose volume is an ext4 mount,
and that is most of them, the mount arrives holding a `lost+found` directory. `initdb` will not
initialize into a directory that has anything in it, so mounting it directly on the data directory
leaves the cluster uncreated — and because `api` waits on `postgres` and `migrate`, the container
starts, the platform reports the deploy a success, and the URL serves a 502. Mounting the parent
leaves `data` as an ordinary subdirectory, which is what PostgreSQL asks for. A Docker named volume
works either way; a platform volume does not. Platforms that offer no persistent volume are the ones to
point at a managed database instead: set `DATABASE_URL` and leave `EMBEDDED_POSTGRES` off. The
`vector` extension must be available there, and the role in `DATABASE_URL` has to be the one that
creates it. The first migration creates it and migration `0010` drops it again, since nothing stores
vectors any more, and only the extension's owner can drop it. So do not enable it ahead of time as
an administrator: that leaves the migrations failing with `must be owner of extension vector`. RDS,
Cloud SQL and Azure Database all offer it; "Your own database" in the Helm guide that comes with
the chart (`helm show readme`) has the grant each one needs.

**Not in it:**

**The supervisor.** It gives each person their own container, and each Isolated Bot one of its own,
which needs a Docker socket, which no serverless container platform permits. Without it, every Bot
shares the one computer, exactly as they do on a laptop with no supervisor configured. Each person's
Bots still keep their own browser profile and folder there, but a shared computer means shared files and
shared session between Bots, which is fine for a deployment where one team trusts its own Bots and
is not fine as a boundary between tenants.

**A routines worker.** None is needed: the server fires due routines itself, inside its own
process, so nothing has to be scheduled beside this container for a routine to fire. See
[routines.md](routines.md).

**The staged-attachment sweep.** A file dropped into the composer is stored before it is sent, and
the server reclaims the ones that never were: it deletes unsent attachments older than 24 hours,
inside its own process, so nothing has to be scheduled beside this container for that either.

Between sweeps, abandoned uploads accumulate in `attachments` up to a ceiling that is one
person's: **32 unsent files each**, counted across every channel and every composer session at once
and refused at the upload endpoint. A file is at most 8 MiB, so that is 256 MiB of staged blobs per
person who uploads, and that is the number to size storage against. It is **not** the eight files
the composer refuses a ninth on: that cap is counted over a bucket the client names in its own
request, so it bounds a client that plays along and nothing else, which is exactly why the
per-person ceiling was added behind it. The refusal a person sees on their 33rd staged file tells
them anything still unsent is cleared within a day, and the server's sweep is what keeps that true.

## Minimum size

Measured on the real image, one Bot, arm64.

| | Measured | Minimum | Recommended |
| --- | --- | --- | --- |
| Memory | 409 MB idle, 498 MB after three page loads, 548 MB after a snapshot | **2 GB** | **4 GB** |
| vCPU | 3 to 6 percent at rest, bursty while a page renders | **1** | **2** |
| Disk | 1.4 GB image | **4 GB** | 8 GB with room for `/workspace` |

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
| `DATABASE_URL` | PostgreSQL where this role can create the `vector` extension. Not needed with `EMBEDDED_POSTGRES=on` |
| an identity provider | `GOOGLE_OAUTH_*`, `MICROSOFT_OAUTH_*` or `OKTA_OAUTH_*`, with `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` and `INITIAL_ADMIN_EMAILS`. See the README |
| `EMBEDDED_POSTGRES` | `on` to run the database inside the container. Off by default |
| `KEY_ENCRYPTION_KEY` | base64 32 bytes. `openssl rand -base64 32`. The example key is refused in production |
| `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY` | CopilotKit Intelligence. A free plan is available and it can be self-hosted |
| `COPILOTKIT_LICENSE_TOKEN` | optional. Managed Intelligence issues none; set it for a self-hosted Intelligence, which needs the same license on its own deployment too |
| a model key | `OPENAI_API_KEY`, or the provider you configured |

`COMPUTER_TOKEN` is generated at start if you do not set one. Both processes that need it are inside
the container, so there is nothing to share it with.

`MANAGED_AGENT_AG_UI_URL` is not required here. The image does not carry the managed Bot
(`agent-langgraph-agui`). Leave it unset and the shipped Risk Analyst coworker is omitted rather than registered
against a host that is not there. Set it, with `MANAGED_AGENT_TOKEN`, only when a Bot is actually
reachable from this container. Unset it if your `.env` still has the laptop default
`http://localhost:4201/ag-ui`.

**Authentication is required.** With no identity provider configured, the deployment refuses to start,
because a public URL where every visitor is an administrator fails silently: it looks like it works.
Configure Google, Microsoft or Okta, or set `OPENBOT_SINGLE_USER=true` to say you meant an open
deployment. `NODE_ENV` does not affect this.

That flag does not cover a public address. `OPENBOT_SINGLE_USER=true` alongside an
`OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL` or `TRUSTED_ORIGINS` entry that the public internet routes
to now refuses to start and names the address, because an open deployment on a public address is
one where every visitor is the administrator. A private address is a different thing and still
runs: a home LAN, a Tailscale or VPN address, or a `.local` name is allowed, with a warning at boot
saying anybody on that network is that administrator. If you want it open on a public address,
put a sign-in provider in front of it.

**Put TLS in front of it.** Not only for the cookies. A page served from `http://<address>` is not a
secure context, which removes a set of browser APIs that are present on `http://localhost` and so
never missing on a laptop. The app does not depend on any of them, but sign-in cookies still want
`Secure`, and every platform below terminates TLS for you.

## Migrations

The server applies its own migrations when it starts, every run, and a database that is already
current is left as it is. That holds with `EMBEDDED_POSTGRES=on` and with an external database
alike, so there is no migration step to run before a deploy.

**If a migration run refuses with "the migrator only runs migrations stamped after the row it
reads"**, this database has recorded a migration stamped later than one it is now being asked to
apply, and nothing has been applied. The migrator decides what to run by comparing journal
timestamps against the newest timestamp in `drizzle.__drizzle_migrations` and nothing else, so a
migration stamped below that mark would be walked past and the run reported as a success over the
tables it should have created. The refusal names every migration in that position.

It happens when a database ran a branch's migrations before that branch was merged: merging renumbers
and restamps the branch's migrations to sit after the ones it merged in, and those merged-in
migrations are older than the stamp the database already holds. Development, preview and reused CI
databases are where it is met.

Recreate the database from empty if it is disposable. If it is not, apply each named migration's SQL
by hand and record it, which leaves the high-water mark where it is and lets the next run proceed:

```sql
insert into drizzle.__drizzle_migrations (hash, created_at)
values ('<sha256 of /app/server/drizzle/<tag>.sql in the server image>', <that entry's "when" in meta/_journal.json>);
```

## Replicas

The page snapshot a Bot resolves element references against lives in Postgres, so a second replica
can answer a click the first one snapshotted. Run more than one if the platform wants it. The
supervisor is still not in this image, so every replica shares the one browser inside it.

## Platform notes

**Google Cloud Run.** Set memory to at least 2 GB. More than one instance is fine (see Replicas
above); each instance has its own browser, so a Bot's logins stay on whichever instance served them.
Cloud Run runs every
container under gVisor, which Chromium is sensitive to; test a navigation before trusting it.
`gcloud run compose up` will also deploy the whole compose file if you want a throwaway database
alongside.

**AWS.** ECS Express Mode provisions the cluster, load balancer, HTTPS and autoscaling from an image
in ECR, and is what AWS points App Runner users at now that App Runner takes no new customers.
Plain ECS on Fargate behind an ALB is the answer if you want task definitions and fine-grained IAM.
No shared-memory configuration is needed or possible.

**Kubernetes.** Everything above describes one container run by hand. A cluster is the other shape,
and it is the only one that gives each person (or an Isolated Bot) a computer of its own, runs the routines schedule without
something outside the container, and scales the API past a single replica. That is the Helm chart published with each release, whose
guide (`helm show readme`) covers EKS, GKE, AKS and a plain self-hosted cluster from the same
templates.

**Azure Container Apps.** Managed ingress with TLS and custom domains. Note the **240-second request
timeout**: the live screen holds a long connection, so expect it to reconnect. Concurrent WebSockets
are capped at 350 per instance on the basic tier.

**Railway, Render, Fly.io.** All run this image directly and all provision PostgreSQL in a click,
which makes them the shortest path from nothing to a running deployment.

## Known costs

**The browser images carry only the Chromium browser family.** The all-in-one image and the
`openbot-agent-computer` image both build from Ubuntu and install Playwright's pinned Chromium
without its separate headless shell, so Firefox and WebKit are never in their layers: every launch
names a Chromium channel, and Playwright runs the full browser for a named channel even when
headless. The images keep the
baseline Node command-line tools (`node`, `npm`, and `npx`) from the official Node 24.18.1 image.
Measured as local zstd OCI layer descriptors against the previous Playwright-base `agent-computer`
image, the compressed image fell from 884.2 MiB to 535.0 MiB on arm64 and from 894.6 MiB to
518.1 MiB on amd64.

**A strict content-security-policy needs a hash or a nonce.** `app/index.html` runs a small inline
script that decides the theme before the first paint. Nothing in this repo sends a CSP header, so it
works as shipped; a deployment that adds one at its proxy has to allow that script explicitly, or
`script-src` blocks it and the page renders with the wrong theme until the app boots. A `'sha256-'`
hash of the script body is the version that survives a rebuild without a per-request nonce.
