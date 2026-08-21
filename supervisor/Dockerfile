# The container supervisor. The only thing in this deployment that holds the Docker socket.
#
# A small image with a two-package dependency tree, because this process is the one
# whose compromise costs the host. Everything it needs is an HTTP server and a Docker client.
# The SPIRE CLI, taken from the official image at a pinned version rather than downloaded at build
# time. It is how entries are registered; without it identity is simply unavailable, which the
# supervisor reports and carries on from.
FROM ghcr.io/spiffe/spire-server:1.15.1 AS spire

FROM oven/bun:1.3.14-alpine

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0. This is the process whose compromise costs the host, so what it runs is the tree that
# was reviewed, not whatever the registry had this morning.
COPY supervisor/package.json supervisor/bun.lock ./
RUN bun install --frozen-lockfile

COPY --from=spire /opt/spire/bin/spire-server /usr/local/bin/spire-server

COPY supervisor/src ./src

EXPOSE 4300
CMD ["bun", "src/index.ts"]
