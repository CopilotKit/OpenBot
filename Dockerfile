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
#   no serverless container platform permits. Without it every Bot shares the browser below, exactly
#   as they do on a laptop with no supervisor configured. Per-Bot isolation is A6.
#
# Chromium comes from Playwright's own installer, but the final image is not Playwright's all-browser
# image. Keep this version matched to `agent-computer/package.json`: bump both or neither.

FROM node:24.18.1-bookworm-slim AS node-toolchain
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun-toolchain

FROM ubuntu:24.04 AS base

# The Bun image digest pins the amd64/arm64 release bytes, including if its tag changes.
ARG PLAYWRIGHT_VERSION=1.62.1
# Keep Bun and global installs readable by the runtime's unprivileged user.
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Ubuntu's primary mirror can serve a package index that disagrees with its own release file for
# hours ("File has unexpected size ... Mirror sync in progress?"), and then every build here fails.
# The Azure mirror is public and kept in step, so apt reads from it unless UBUNTU_MIRROR says
# otherwise (arm64 reads ports.ubuntu.com, which this leaves alone). Retries cover a dropped download.
ARG UBUNTU_MIRROR=http://azure.archive.ubuntu.com/ubuntu
RUN sed -i "s#http://archive.ubuntu.com/ubuntu/\?#${UBUNTU_MIRROR}/#; s#http://security.ubuntu.com/ubuntu/\?#${UBUNTU_MIRROR}/#" /etc/apt/sources.list.d/ubuntu.sources \
  && printf 'Acquire::Retries "5";\n' > /etc/apt/apt.conf.d/80-retries
COPY --from=node-toolchain /usr/local /usr/local
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun
# `--no-shell` and the bunx cache: see agent-computer/Dockerfile, which installs the same browser.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils \
  && ln -s bun /usr/local/bin/bunx \
  && bunx --bun "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --no-shell chromium \
  && rm -rf /root/.cache /root/.bun /usr/local/install/cache /tmp/* /var/lib/apt/lists/* \
  # PINNED, BECAUSE THE CHART NAMES THESE NUMBERS. `computers.podSecurityContext` runs a computer
  # pod as 1001, and without `--uid` that is only where these happen to land today: `ubuntu:24.04`
  # ships its own `ubuntu` user at 1000, so the next two are 1001 and 1002. Let the base add one
  # more user ahead of these and every number shifts, the chart keeps asking for 1001, and a Bot's
  # computer starts as a uid that owns none of its files. Pinning makes it a contract.
  && useradd --uid 1001 --create-home --shell /bin/bash pwuser \
  && useradd --uid 1002 --create-home --shell /usr/sbin/nologin apiuser


FROM base AS deps

WORKDIR /src

# Manifests first, so editing a source file does not reinstall the world.
COPY package.json bun.lock ./
COPY tsconfig.base.json bunfig.toml ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY shared/package.json shared/package.json
COPY toolkit/package.json toolkit/package.json
COPY extension/package.json extension/package.json
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
  && cd /prod && mkdir -p app server worker shared toolkit extension \
  && cp /src/app/package.json app/package.json \
  && cp /src/server/package.json server/package.json \
  && cp /src/worker/package.json worker/package.json \
  && cp /src/shared/package.json shared/package.json \
  && cp /src/toolkit/package.json toolkit/package.json \
  && cp /src/extension/package.json extension/package.json \
  && bun install --frozen-lockfile --production


FROM deps AS app-build

COPY app app
COPY scripts scripts
COPY shared shared
COPY toolkit toolkit
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
# A GITHUB 504 MUST NOT FAIL THE BUILD. This was `ADD <url>`, and BuildKit works out an ADD's cache key
# by requesting the URL on every build, cache or no cache, retrying only a 429 or a 503. When
# github.com's release downloads answered 504 the build died with "failed to load cache key: invalid
# response status 504" before any cache was read. A RUN's cache key is its own text, so once this
# layer is in the cache the download is not attempted at all. When it does run, curl retries the
# 5xx, and if github.com's download page stays down the same file comes through the REST API's
# release-asset endpoint, which is served separately. Either way the bytes are checked against the
# checksums s6 publishes with the release (`<name>.sha256`), so a bump changes the version, the
# three checksums and the three asset ids together.
ARG S6_OVERLAY_NOARCH_SHA256=42e038a9a00fc0fef70bf0bc42f625a9c14f8ecdfe77d4ad93281edf717e10c5
ARG S6_OVERLAY_X86_64_SHA256=8bcbc2cada58426f976b159dcc4e06cbb1454d5f39252b3bb0c778ccf71c9435
ARG S6_OVERLAY_AARCH64_SHA256=c8fd6b1f0380d399422fc986a1e6799f6a287e2cfa24813ad0b6a4fb4fa755cc
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) S6_ARCH=x86_64; S6_ARCH_SHA256="${S6_OVERLAY_X86_64_SHA256}"; S6_ARCH_ASSET=252547925 ;; \
      arm64) S6_ARCH=aarch64; S6_ARCH_SHA256="${S6_OVERLAY_AARCH64_SHA256}"; S6_ARCH_ASSET=252547981 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    fetch() { \
      curl -fsSL --retry 5 --retry-all-errors -o "/tmp/$1" \
        "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/$1" \
      || curl -fsSL --retry 5 --retry-all-errors -H 'Accept: application/octet-stream' -o "/tmp/$1" \
        "https://api.github.com/repos/just-containers/s6-overlay/releases/assets/$2"; \
      echo "$3  /tmp/$1" | sha256sum -c -; \
    }; \
    fetch s6-overlay-noarch.tar.xz 252547954 "${S6_OVERLAY_NOARCH_SHA256}"; \
    fetch "s6-overlay-${S6_ARCH}.tar.xz" "${S6_ARCH_ASSET}" "${S6_ARCH_SHA256}"; \
    tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz; \
    tar -C / -Jxpf "/tmp/s6-overlay-${S6_ARCH}.tar.xz"; \
    rm /tmp/s6-overlay-*.tar.xz

# WHAT THE X SERVER EXPECTS TO FIND, made by root. A Bot's computer starts Xvfb as `pwuser` (s6 drops
# to it; a chart computer pod is 1001 from the start, `computers.podSecurityContext`). Xvfb wants
# /tmp/.X11-unix owned by root and sticky, will not make it as anyone else, and said
# `_XSERVTransmkdir: ERROR: euid != 0` at every start though the display worked. Made here with the
# mode it would have made, it is simply there. /tmp is the image's own in every pod the chart runs:
# no volume is mounted over it.
#
# The keysym names Ubuntu 24.04's keyboard data uses and its libX11 does not know yet, which xkbcomp
# warned about once each at every start. See the file.
RUN install -d -m 1777 /tmp/.X11-unix
COPY docker/x11/XKeysymDB /usr/share/X11/XKeysymDB

WORKDIR /app

# BOTH HALVES OF THE TREE COME FROM /prod. A workspace install is two directories, not one: the
# packages it could hoist go to the root `node_modules`, and a per-workspace `node_modules` sits
# beside each manifest holding the rest. The server's half used to be taken from /src, which is the
# unpruned install, so the prune above bought nothing where the server actually resolves — and
# `@copilotkit/aimock`, a development dependency, shipped as a symlink into a store the prune had
# emptied, along with the two `.bin` shims pointing at it. Every dependency `server/package.json`
# declares resolves from the /prod half; the ones it does not declare are absent now rather than
# present and broken.
COPY --from=deps /prod/node_modules node_modules
COPY --from=deps /prod/server/node_modules server/node_modules
COPY --from=deps /prod/toolkit/node_modules toolkit/node_modules
# shared files import zod at runtime, and the isolated install resolves it from shared/node_modules
COPY --from=deps /prod/shared/node_modules shared/node_modules
COPY --from=deps /src/package.json package.json
COPY --from=deps /src/bun.lock bun.lock
# The browser's tree is a separate install root with its own lockfile rather than a workspace of the
# one above, so there is no /prod half of it to take and it ships as resolved, `typescript` included.
# Pruning it would mean a second `--production` install in the stage above.
COPY --from=deps /src/agent-computer/node_modules agent-computer/node_modules

COPY server server
COPY shared shared
COPY toolkit toolkit
COPY examples examples
COPY agent-computer/src agent-computer/src
COPY agent-computer/package.json agent-computer/package.json

# `bun run composio:smoke`, because the manifest copied above carries that entry and the question it
# answers belongs here rather than on a laptop: it asks what THIS deployment's Composio key can see,
# and that key is the one in this container's environment. It reads `server/src/plugins/composio*`,
# which is already in the image, so the file itself was the only thing missing and the entry was an
# instruction that could not be followed where it shipped.
#
# ONE FILE, NOT `scripts/`. The others there are the laptop's. `diagram` and `mock:knowledge` reach
# for `roughjs` and `@copilotkit/aimock`, which the prune above removes; `test:ci` runs a suite that
# is not in the image; `generate:app-config` writes a file the build has already baked into
# `app/dist`. Copying the directory ships four more entries with nothing to do here, to fix one that
# has something to do.
COPY scripts/composio-smoke.ts scripts/composio-smoke.ts

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
# ONE COMMAND, NOT THE PACKAGE MANAGERS. This was `NOPASSWD: ALL`, then the package managers by name:
# apt-get, apt, dpkg, apt-key and apt-cache, with any arguments. The second read as a narrowing and
# was not one. `sudo apt-get update -o APT::Update::Pre-Invoke::=<command>` runs that command as
# root, and so do a `.deb` handed to dpkg and the pager `apt-get changelog` opens. Root here is not
# a Bot's own business: the supervisor is deliberately not in this image, so every Bot shares one
# computer, and `EMBEDDED_POSTGRES=on` is a documented way to run it. Root reads
# /run/s6/container_environment, which holds BETTER_AUTH_SECRET, KEY_ENCRYPTION_KEY and the
# database's password, and with those every credential, every session and the audit database.
#
# So sudo now runs `openbot-apt` and nothing else. It takes `update`, or `install` and package
# names, and refuses any other argument; `docker/openbot-apt` says what it refuses and why. Root's,
# in a directory that is root's, so the Bot cannot change what sudo runs. `sudo openbot-apt install
# jq` is what the tool description tells a model to run here. `sudo apt-get` is refused.
#
# The environment stays sudo's to reset (`env_reset` in Ubuntu's /etc/sudoers) and the helper
# clears it again, so nothing the Bot exports reaches apt-get. DEBIAN_FRONTEND is set by the
# helper rather than passed through.
#
# WHAT THIS IS NOT. It is a floor, not a boundary. Root is one CVE away and a shared container is not
# an isolation story for code a model wrote: that needs a computer per Bot and a sandbox under it,
# which is why per-Bot computers and gVisor are not optional extras next to this feature. Run the
# image with `--security-opt no-new-privileges` where the platform allows and the Bots need not
# install anything: it turns setuid off, sudo with it, so installing stops too.
COPY docker/openbot-apt /usr/local/sbin/openbot-apt
RUN apt-get update && apt-get install -y --no-install-recommends sudo \
  && rm -rf /var/lib/apt/lists/* \
  && chown root:root /usr/local/sbin /usr/local/sbin/openbot-apt \
  && chmod 0755 /usr/local/sbin /usr/local/sbin/openbot-apt \
  && printf '%s\n' \
    'pwuser ALL=(root) NOPASSWD: /usr/local/sbin/openbot-apt' \
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
# genuinely differ: the browser and the Bot's shell run as `pwuser`, the API and migrations as
# `apiuser`, the database as `postgres`. One shared account would put the process that renders the
# open internet in the same skin as the one holding the audit trail.
#
# This matters more than usual here. Chromium is launched with `--no-sandbox` unless the host can
# support its sandbox, and with that flag the process user IS the boundary, so root would mean a
# page exploit lands as root.
#
# The two directories the browser writes are its workspace and its profile, the second being what
# keeps a Bot signed in between turns. Owned here, because a non-root process cannot create them at
# the root of the filesystem and the failure surfaces as EACCES on the first navigation. Its other
# writes go to its home directory and /tmp, which it can write already.
#
# /APP STAYS ROOT'S. It was chowned to `pwuser` along with these two when the API ran as `pwuser`
# too, and stayed that way after the API moved to `apiuser`. Owning it let a Bot's shell rewrite
# the code the API runs on its next start, and `app/dist`, which the API serves from disk on every
# request: a script added to `index.html` runs in the browser of every admin who opens the app.
# Nothing either process runs writes under /app, so both read it and neither owns it.
#
# Root's is not yet read-only to everybody else. Bun's install leaves each package's executable
# (`semver/bin/semver.js`, `typescript/bin/tsc`, fifty-odd of them) at mode 0777, so a Bot could
# still rewrite those. Taking the write bit for group and others off is what makes "root's" true.
RUN mkdir -p /workspace /profiles \
  && chown -R pwuser:pwuser /workspace /profiles \
  && find /app -perm /022 ! -type l -exec chmod go-w {} +

# Where the embedded database answers, when there is one. Overridden by whatever you set, so an
# external database needs no special case: set DATABASE_URL and EMBEDDED_POSTGRES stays off.
ENV EMBEDDED_POSTGRES=off
ENV DATABASE_URL=postgres://openbot@127.0.0.1:5432/openbot

# Public, build-bound identity. Ordinary local builds leave it unknown; release CI supplies all five.
ARG OPENBOT_BUILD_VERSION
ARG OPENBOT_BUILD_COMMIT
ARG OPENBOT_BUILD_DISTRIBUTION_ID
ARG OPENBOT_BUILD_REPOSITORY
ARG OPENBOT_BUILD_CHANNEL
ENV OPENBOT_BUILD_VERSION=${OPENBOT_BUILD_VERSION} \
    OPENBOT_BUILD_COMMIT=${OPENBOT_BUILD_COMMIT} \
    OPENBOT_BUILD_DISTRIBUTION_ID=${OPENBOT_BUILD_DISTRIBUTION_ID} \
    OPENBOT_BUILD_REPOSITORY=${OPENBOT_BUILD_REPOSITORY} \
    OPENBOT_BUILD_CHANNEL=${OPENBOT_BUILD_CHANNEL}

# Where this server runs, said by the image so no deployment has to. On a single-user OpenBot outside a
# container only callers on this machine are the administrator; in here every caller arrives through
# the container engine's network, so that rule would refuse everybody. See `singleUserAccess` in
# server/src/config.ts.
ENV OPENBOT_IN_CONTAINER=true
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# One port out. The browser's 4100 is deliberately not exposed: it holds real logins and its only
# caller is the process next to it.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3001/health'); process.exit(r.ok ? 0 : 1)"

ENTRYPOINT ["/init"]
