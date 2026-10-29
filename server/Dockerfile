# The API, the app it serves, and the routines worker, in one image.
#
# ONE IMAGE ON PURPOSE. There is no CORS anywhere in the server, so the app must reach `/api` on its
# own origin. Shipping them together means a deployment needs one service and no path rules, and the
# two halves cannot end up disagreeing about which host they are on.
#
# The worker rides along for a smaller version of the same reason: it is the server's own routine
# sweep (`server/src/routines/sweep.ts`) in a loop, importing the server's source rather than a copy
# of it, so a worker built from another commit would be sweeping with somebody else's rules. One
# image runs either process; the command decides which.
#
# Multi-stage so the build's dependencies do not ship. Non-root because nothing here needs to be.

FROM oven/bun:1.4.3 AS deps

WORKDIR /app

# Manifests before sources, so a source change does not reinstall the world.
COPY package.json bun.lock ./
# The dependency patches package.json names in patchedDependencies: the install stops without them.
COPY patches patches
# The shared tsconfig, which every package extends. Vite reads it while transforming and fails
# without it, in a stack trace that names esbuild rather than a missing file.
COPY tsconfig.base.json tsconfig.base.json
COPY bunfig.toml bunfig.toml
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY shared/package.json shared/package.json
COPY toolkit/package.json toolkit/package.json
COPY extension/package.json extension/package.json
RUN bun install --frozen-lockfile


FROM deps AS app-build

# `prebuild` generates the app's config, so the app is built through its own script rather than by
# calling vite directly, or the generated file is missing and the build fails on an import.
COPY app app
COPY scripts scripts
COPY shared shared
COPY toolkit toolkit
# The server's source too: `generate-app-config` reads the tenant package through
# `server/src/tenant-package`, so the app cannot be built without it.
COPY server server
COPY examples examples
RUN bun run --cwd app build


FROM oven/bun:1.4.3 AS runtime

# Not root. The API opens a socket and talks to Postgres; neither needs privileges, and a Chromium
# container is a separate image with its own reasons.
RUN groupadd --system --gid 1001 openbot \
  && useradd --system --uid 1001 --gid openbot openbot

WORKDIR /app

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY --from=deps /app/bun.lock bun.lock
COPY --from=deps /app/server/node_modules server/node_modules
COPY --from=deps /app/toolkit/node_modules toolkit/node_modules
# shared files import zod at runtime, and the isolated install resolves it from shared/node_modules
COPY --from=deps /app/shared/node_modules shared/node_modules
# The worker's own `node_modules` holds one thing, the link to `@openbot/shared`, and without it the
# first import in `worker/src/env.ts` fails. The install is isolated: each workspace resolves through
# the folder beside its own manifest, so the server's copy of that link is no use to the worker.
COPY --from=deps /app/worker/node_modules worker/node_modules

COPY server server
COPY shared shared
COPY toolkit toolkit
COPY examples examples
# Its source and manifest, not its tests. Run it with `bun ../worker/src/index.ts` from the working
# directory below; it reaches the server's source by relative import, so it needs `server/` beside
# it, which is already here.
COPY worker/package.json worker/package.json
COPY worker/src worker/src

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
CMD ["bun", "src/production-entry.ts"]
