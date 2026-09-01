# The Bot's computer uses Playwright's image so Chromium and its system libraries stay matched.
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ARG BUN_VERSION=1.3.14
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"

# A real desktop, not a page-only screencast. Xvfb owns the display, Openbox supplies window chrome,
# x11vnc publishes its framebuffer, and websockify carries RFB through the authenticated OpenBot
# WebSocket proxy. None of these ports are exposed from the container.
#
# unzip is not in the Playwright image and bun's installer needs it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus-x11 \
    openbox \
    tint2 \
    unzip \
    websockify \
    x11vnc \
    x11-xserver-utils \
    xterm \
    xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY agent-computer/package.json agent-computer/bun.lock ./
RUN bun install --frozen-lockfile

COPY agent-computer/src ./src
COPY agent-computer/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Durable working directory. Bot-produced files that must survive replacement live here.
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

ENV PORT=4100
EXPOSE 4100
# Readiness is exposed through Docker health so the supervisor need not know the network route.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

CMD ["./entrypoint.sh"]
