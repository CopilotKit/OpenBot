# Product Engineer sidecar — separate from ghcr.io/copilotkit/openbot.
FROM oven/bun:1.4.2-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PE_RUNS_DIR=/data/runs

# Workspace install from the repo lockfile (same pattern as agent-mastra).
COPY package.json bun.lock ./
COPY product-engineer-loop/package.json ./product-engineer-loop/
COPY product-engineer-sidecar/package.json ./product-engineer-sidecar/
# Other workspace package.json stubs so the root lockfile can resolve workspace:* entries.
COPY app/package.json ./app/
COPY shared/package.json ./shared/
COPY extension/package.json ./extension/
COPY management-agent/package.json ./management-agent/

RUN bun install --frozen-lockfile

COPY product-engineer-loop ./product-engineer-loop
COPY product-engineer-sidecar ./product-engineer-sidecar

WORKDIR /app/product-engineer-sidecar
VOLUME ["/data/runs"]
EXPOSE 3020
CMD ["bun", "src/server.ts"]
