# Product Engineer sidecar — separate from ghcr.io/copilotkit/openbot.
FROM oven/bun:1.4.2-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PE_RUNS_DIR=/data/runs
COPY product-engineer-loop ./product-engineer-loop
COPY product-engineer-sidecar ./product-engineer-sidecar
RUN printf '%s\n' \
  '{"name":"pe-root","private":true,"workspaces":["product-engineer-loop","product-engineer-sidecar"]}' \
  > package.json \
  && bun install
WORKDIR /app/product-engineer-sidecar
VOLUME ["/data/runs"]
EXPOSE 3020
CMD ["bun", "src/server.ts"]
