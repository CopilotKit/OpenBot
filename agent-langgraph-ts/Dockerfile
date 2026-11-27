# LangGraph in TypeScript, as a Bot. Node 22, because LangGraph JS 1.x requires it, running the
# TypeScript sources directly (Node strips the types), so the image holds no build step.
FROM node:22.23.5-bookworm-slim

WORKDIR /app

# Dependencies before source, so editing the Bot does not re-resolve the framework.
COPY agent-langgraph-ts/package.json agent-langgraph-ts/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY shared/listen-port.ts shared/model-providers.ts shared/model-providers.json shared/recall-earlier-results.ts shared/tool-search.ts /shared/
COPY agent-langgraph-ts/src ./src

ENV NODE_ENV=production PORT=4215
EXPOSE 4215
USER node

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4215) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# 0.0.0.0 inside the container (see src/main.ts); Compose decides which host addresses publish it.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
