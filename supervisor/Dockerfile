# The container supervisor. The only thing in this deployment that holds the Docker socket.
#
# A small image with a two-package dependency tree, because this process is the one
# whose compromise costs the host. Everything it needs is an HTTP server and a Docker client.
# The SPIRE CLI, taken from the official image at a pinned version rather than downloaded at build
# time. It is how entries are registered; without it identity is simply unavailable, which the
# supervisor reports and carries on from.
FROM ghcr.io/spiffe/spire-server:1.15.1 AS spire

FROM oven/bun:1.4.3-alpine

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0. This is the process whose compromise costs the host, so what it runs is the tree that
# was reviewed, not whatever the registry had this morning.
COPY supervisor/package.json supervisor/bun.lock ./
RUN bun install --frozen-lockfile

COPY --from=spire /opt/spire/bin/spire-server /usr/local/bin/spire-server

COPY supervisor/src ./src
# environment.ts imports ../../shared/computer-token, the one derivation of each computer's own token
# that the server uses too, so it goes where that path resolves from /app/src. It imports only
# node:crypto, so it needs no dependency tree of its own.
COPY shared/computer-token.ts /shared/computer-token.ts

EXPOSE 4300
CMD ["bun", "src/index.ts"]
