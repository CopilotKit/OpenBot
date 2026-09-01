# OpenBot, whole, in one container.
#
# WHAT THIS IS FOR. Everything a laptop runs, minus the database, in one image on one port. Deploy it
# anywhere that runs a container and you get what `scripts/start.sh` gives you locally: the app, the
# API, and a browser the Bots can drive.
#
# WHAT IS NOT HERE, AND WHY.
#
#   PostgreSQL. A container filesystem does not survive a redeploy and the audit trail is the
#   product. `DATABASE_URL` points at a managed instance, which is one click on every platform this
#   is meant to run on.
#
#   The supervisor. It exists to give each Bot its own container, which needs a Docker socket, which
#   no serverless container platform permits. Without it every Bot shares the desktop below, exactly
#   as they do on a laptop with no supervisor configured. Kubernetes deployments use
#   `computers.mode: sandbox` or `vm` for one isolated computer per Bot.
#
# THE BASE IS PLAYWRIGHT'S, not Bun's, because Chromium and its system libraries have to stay
# matched and that image is the only place that is guaranteed. The tag must move with the
# `playwright` dependency in `agent-computer/package.json`. Bump both or neither.

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS base

# unzip is not in the Playwright image and bun's installer needs it.
# Bun is pinned. The installer takes whatever is newest otherwise, so the runtime drifts from the
# one the lockfile was resolved against and an image built next month is not the image built today.
ARG BUN_VERSION=1.3.14
# Into /usr/local rather than /root/.bun, because the runtime stage runs as `pwuser` and cannot read
# root's home. Set before the install, or the installer has already chosen the wrong directory.
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus-x11 \
    openbox \
    tint2 \
    unzip \
    websockify \
    x11vnc \
    x11-xserver-utils \
    xterm \
    xz-utils \
    xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"


FROM base AS deps

WORKDIR /src

# Manifests first, so editing a source file does not reinstall the world.
COPY package.json bun.lock ./
COPY tsconfig.base.json bunfig.toml ./
COPY app/package.json app/package.json
COPY agent-codex/package.json agent-codex/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
RUN bun install --frozen-lockfile

# The lockfile travels with the manifest, because `--frozen-lockfile` with no lockfile in the context
# is not an error: bun resolves afresh, succeeds, and the flag has decorated nothing. With both files
# here, the tree in the image is the tree this repository resolved and committed. Bun is already
# pinned twenty-odd lines above for the same reason; this is the install below it.
COPY agent-computer/package.json agent-computer/package.json
COPY agent-computer/bun.lock agent-computer/bun.lock
RUN cd agent-computer && bun install --frozen-lockfile

# A second tree with the build-time dependencies left out, for the runtime stage to take. Vite,
# biome and the test tooling are a gigabyte that nothing in a running container imports.
RUN mkdir -p /prod && cp package.json bun.lock /prod/ \
  && cp -r app/package.json /prod/app-package.json \
  && cd /prod && mkdir -p app agent-codex server worker \
  && cp /src/app/package.json app/package.json \
  && cp /src/agent-codex/package.json agent-codex/package.json \
  && cp /src/server/package.json server/package.json \
  && cp /src/worker/package.json worker/package.json \
  && bun install --frozen-lockfile --production


FROM deps AS app-build

COPY app app
COPY scripts scripts
COPY shared shared
# The server's source as well: the app's prebuild step reads the tenant package through
# `server/src/tenant-package`, so the app cannot be built without it.
COPY server server
COPY examples examples
RUN bun run --cwd app build


FROM base AS runtime

# s6 rather than supervisord. The deciding difference is that s6 brings the container down when a
# supervised process exits, which is what makes the platform restart it. supervisord stays alive and
# the container keeps reporting healthy while the API inside it is dead.
ARG S6_OVERLAY_VERSION=3.2.1.0
# `TARGETARCH` is filled in by the builder. s6 names its tarballs by uname, so amd64 and arm64 have
# to be translated. Hardcoding one of them builds fine on the other and then fails at start with an
# exec format error, which reads as a broken image rather than a wrong download.
ARG TARGETARCH
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/
RUN case "${TARGETARCH}" in \
      amd64) S6_ARCH=x86_64 ;; \
      arm64) S6_ARCH=aarch64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL -o /tmp/s6-overlay-arch.tar.xz \
    "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
  && tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz \
  && tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz \
  && rm /tmp/s6-overlay-*.tar.xz

WORKDIR /app

COPY --from=deps /prod/node_modules node_modules
COPY --from=deps /src/package.json package.json
COPY --from=deps /src/bun.lock bun.lock
COPY --from=deps /src/server/node_modules server/node_modules
COPY --from=deps /src/agent-computer/node_modules agent-computer/node_modules

COPY server server
COPY shared shared
COPY examples examples
COPY agent-computer/src agent-computer/src
COPY agent-computer/package.json agent-computer/package.json
COPY agent-computer/entrypoint.sh agent-computer/entrypoint.sh
RUN chmod +x agent-computer/entrypoint.sh

# The built app, served by the API on the same origin. There is no CORS in this server, so this is
# not a convenience: two origins would simply fail.
COPY --from=app-build /src/app/dist app/dist
ENV APP_DIST_DIR=/app/app/dist

COPY docker/s6 /etc/s6-overlay

# PostgreSQL, for the deployment that wants one thing to run rather than two.
#
# OFF UNLESS ASKED FOR. Set `EMBEDDED_POSTGRES=on` and the container runs its own; leave it and
# `DATABASE_URL` points wherever you like. The trade is the one you would expect: a database inside
# a container lives and dies with that container unless /var/lib/postgresql is a mounted volume, and
# the audit trail is the thing you would be losing.
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-16 postgresql-16-pgvector \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/postgresql/data /var/run/postgresql \
  && chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql

# A Bot can install what a task needs, and nothing else as root.
#
# `sudo` without a password, because a package manager that cannot install is not one, and "install a
# tool then use it" is the whole point of giving a Bot a shell.
#
# THE PACKAGE MANAGERS, NOT ALL. This was `NOPASSWD: ALL`, and the comment below it explained what
# that cost: a Bot could become root inside its container. It then named the two conditions that make
# that acceptable — the container being one Bot's alone, and not holding a database — and this image
# meets neither. The supervisor is deliberately not in it, so every Bot shares one computer, and
# `EMBEDDED_POSTGRES=on` is a documented way to run it. So root here read another Bot's workspace, the
# API's environment, and the audit database that records what it did.
#
# Naming the commands keeps the feature and removes that. `apt-get install` still works, which is what
# the tool description tells a model to run. `sudo cat /proc/1/environ` does not.
#
# WHAT THIS IS NOT. It is a floor, not a boundary. Root is one CVE away and a shared container is not
# an isolation story for code a model wrote: that needs a computer per Bot and a sandboxed runtime
# under it. Kubernetes deployments get that with `computers.mode: sandbox`, or `vm` plus a Kata
# runtime class for a hardware-virtualized boundary. Run the image with
# `--security-opt no-new-privileges` where the platform allows, which turns setuid off entirely for
# anything not named here.
RUN apt-get update && apt-get install -y --no-install-recommends sudo \
  && rm -rf /var/lib/apt/lists/* \
  && printf '%s\n' \
    'pwuser ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg, /usr/bin/apt-key, /usr/bin/apt-cache' \
    'Defaults!/usr/bin/apt-get env_keep += "DEBIAN_FRONTEND"' \
    > /etc/sudoers.d/pwuser \
  && chmod 0440 /etc/sudoers.d/pwuser \
  && visudo -cf /etc/sudoers.d/pwuser

# THE PACKAGE MANAGER AND THE SHELL STAY. Both were removed here once as hardening, which was
# backwards: a Bot being able to open a shell and install what a task needs is a requested feature,
# not an oversight. Removing them hardens the image by deleting the product.
#
# What makes that safe is not their absence. It is that a Bot reaches them the same way it reaches
# anything else, through the gateway: resolve, decide against the policy, write the audit row, then
# act. A command is a decision like a click is.

# Where a Bot's files live. Mount a volume here to keep them across a redeploy; without one they are
# as durable as the container, which for a trial is the honest default.
ENV WORKSPACE_DIR=/workspace
ENV PROFILES_DIR=/profiles

# The browser is on loopback inside this container and reachable from nowhere else.
#
# No private-host allowance is set for it, and none is needed. Reaching the sibling process goes
# through `checkComputerAddress`, which decides on the protocol and the metadata floor and never
# consults `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS`. That switch governs where a *Bot* may browse and
# which endpoint one may be registered against, so setting it here bought nothing for this address
# and let a Bot reach whatever this container's network reaches, which on a default bridge is the
# host's LAN.
ENV AGENT_COMPUTER_URL=http://127.0.0.1:4100

# NOTHING THAT MATTERS RUNS AS ROOT.
#
# s6 stays root because that is the only way it can drop each service to a different user, and they
# genuinely differ: the browser and API run as `pwuser`, the database as `postgres`. One shared
# account would put the process that renders the open internet in the same skin as the one holding
# the audit trail.
#
# This matters more than usual here. Chromium is launched with `--no-sandbox` unless the host can
# support its sandbox, and with that flag the process user IS the boundary, so root would mean a
# page exploit lands as root.
#
# The two directories the browser writes are its workspace and its profile, the second being what
# keeps a Bot signed in between turns. Owned here, because a non-root process cannot create them at
# the root of the filesystem and the failure surfaces as EACCES on the first navigation.
RUN mkdir -p /workspace /profiles \
  && chown -R pwuser:pwuser /workspace /profiles /app

# Where the embedded database answers, when there is one. Overridden by whatever you set, so an
# external database needs no special case: set DATABASE_URL and EMBEDDED_POSTGRES stays off.
ENV EMBEDDED_POSTGRES=off
ENV DATABASE_URL=postgres://openbot@127.0.0.1:5432/openbot

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# One port out. The browser's 4100 is deliberately not exposed: it holds real logins and its only
# caller is the process next to it.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3001/health'); process.exit(r.ok ? 0 : 1)"

ENTRYPOINT ["/init"]
