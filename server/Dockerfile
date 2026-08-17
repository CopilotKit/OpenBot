FROM oven/bun:1.3.14

WORKDIR /app

COPY package.json bun.lock ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
RUN bun install --frozen-lockfile

COPY server server
COPY examples examples

WORKDIR /app/server
