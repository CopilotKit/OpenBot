# Local integration fixture for the stopped-image reader. This is a package-only
# image, not the production application image or evidence of production health.
ARG BUN_IMAGE=oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
FROM ${BUN_IMAGE}
WORKDIR /app
COPY package.json bun.lock ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
RUN bun install --frozen-lockfile --production
COPY server server
COPY shared shared
COPY examples/netsfera examples/netsfera
