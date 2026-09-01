# The API and the app it serves, in one image.
#
# ONE IMAGE ON PURPOSE. There is no CORS anywhere in the server, so the app must reach `/api` on its
# own origin. Shipping them together means a deployment needs one service and no path rules, and the
# two halves cannot end up disagreeing about which host they are on.
#
# Multi-stage so the build's dependencies do not ship. Non-root because nothing here needs to be.

FROM oven/bun:1.3.14 AS deps

WORKDIR /app

# Manifests before sources, so a source change does not reinstall the world.
COPY package.json bun.lock ./
# The shared tsconfig, which every package extends. Vite reads it while transforming and fails
# without it, in a stack trace that names esbuild rather than a missing file.
COPY tsconfig.base.json tsconfig.base.json
COPY bunfig.toml bunfig.toml
COPY app/package.json app/package.json
COPY agent-codex/package.json agent-codex/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
RUN bun install --frozen-lockfile


FROM deps AS app-build

# `prebuild` generates the app's config, so the app is built through its own script rather than by
# calling vite directly, or the generated file is missing and the build fails on an import.
COPY app app
COPY scripts scripts
COPY shared shared
# The server's source too: `generate-app-config` reads the tenant package through
# `server/src/tenant-package`, so the app cannot be built without it.
COPY server server
COPY examples examples
RUN bun run --cwd app build


FROM oven/bun:1.3.14 AS runtime

# Not root. The API opens a socket and talks to Postgres; neither needs privileges, and a Chromium
# container is a separate image with its own reasons.
RUN groupadd --system --gid 1001 openbot \
  && useradd --system --uid 1001 --gid openbot openbot

WORKDIR /app

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY --from=deps /app/bun.lock bun.lock
COPY --from=deps /app/server/node_modules server/node_modules

COPY server server
COPY shared shared
COPY examples examples

# The built app, served by the process below. `APP_DIST_DIR` is what turns that on, so an image
# without this layer is still a working API.
COPY --from=app-build /app/app/dist app/dist
ENV APP_DIST_DIR=/app/app/dist

USER openbot:openbot

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

WORKDIR /app/server

# Migrations are a release step, not a start step: two replicas starting together would race, and a
# failed migration should stop a deploy rather than leave a half-migrated database serving.
CMD ["bun", "src/index.ts"]
