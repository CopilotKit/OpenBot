# The Bot's computer installs only the Playwright browser it launches, and carries the built OpenBot
# Recorder for the person's browser it opens (the OpenBot Browser).
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM node:24.18.1-bookworm-slim AS node-toolchain
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun-toolchain

# The Recorder, built here from the repository root as the root Dockerfile builds the app: the
# workspace manifests and lockfile first, so a source edit does not reinstall the world, then the
# sources the build reads. It needs the root install because the extension is a workspace and its
# pages are drawn with the app's own components (`app/src`). Only `extension/dist` leaves this stage.
FROM bun-toolchain AS recorder-build
WORKDIR /src
COPY package.json bun.lock ./
# The dependency patches package.json names in patchedDependencies: the install stops without them.
COPY patches patches
COPY tsconfig.base.json bunfig.toml ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY shared/package.json shared/package.json
COPY toolkit/package.json toolkit/package.json
COPY extension/package.json extension/package.json
RUN bun install --frozen-lockfile
COPY app/src app/src
COPY shared shared
COPY extension extension
RUN bun run --cwd extension build

FROM ubuntu:24.04

# The Bun image digest pins the amd64/arm64 release bytes, including if its tag changes.
ARG PLAYWRIGHT_VERSION=1.62.1
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=node-toolchain /usr/local /usr/local
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun
# `--no-shell`: every launch names a Chromium channel (`browser-runtime.ts`), and Playwright runs
# the full build for a named channel even when headless, so the headless shell is never started. It
# was 340 MB unpacked and about 106 MB of every download. The bunx package cache goes too: Bun
# writes it under both BUN_INSTALL and the home directory, 35 MB the image never reads.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils \
  && ln -s bun /usr/local/bin/bunx \
  && bunx --bun "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --no-shell chromium \
  && rm -rf /root/.cache /root/.bun /usr/local/install/cache /tmp/* /var/lib/apt/lists/*

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY agent-computer/package.json agent-computer/bun.lock ./
RUN bun install --frozen-lockfile

COPY agent-computer/src ./src
# index.ts imports ../../shared/file-download at runtime (shared/computer-control is type-only and
# erased), and the browser routes import ../../shared/openbot-browser and ../../shared/bot-browser,
# so the files they need go where those paths resolve from /app/src.
COPY shared/file-download.ts /shared/file-download.ts
# The OpenBot Browser's contract and a Bot's browser's, which the browser routes check requests
# against. They import zod, and a module resolves its imports from its own directory upward, which
# from /shared never reaches /app/node_modules: so /shared is given that tree to resolve from, rather
# than a second install.
COPY shared/openbot-browser.ts shared/bot-browser.ts /shared/
COPY shared/recorder-extension.ts shared/recorder-extension.json /shared/
RUN ln -s /app/node_modules /shared/node_modules

# The built Recorder, put into every person's browser this computer opens. Without it the computer
# still serves Bots and refuses to open a person's browser, saying why.
COPY --from=recorder-build /src/extension/dist /recorder
ENV OPENBOT_RECORDER_DIR=/recorder

# Durable working directory. Bot-produced files that must survive replacement live here.
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

ENV PORT=4100
EXPOSE 4100
# Readiness is exposed through Docker health so the supervisor need not know the network route.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/index.ts"]
