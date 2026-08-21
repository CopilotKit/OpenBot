# The Bot's computer uses Playwright's image so Chromium and its system libraries stay matched.
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# unzip is not in the Playwright image and bun's installer needs it.
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY agent-computer/package.json agent-computer/bun.lock ./
# Installed against the committed lockfile. It was not in the build context before, so the file
# existed and could not have been honoured.
RUN bun install --frozen-lockfile

COPY agent-computer/src ./src

# Durable working directory. Bot-produced files that must survive replacement live here.
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

ENV PORT=4100
EXPOSE 4100
# Readiness is exposed through Docker health so the supervisor need not know the network route.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/index.ts"]
