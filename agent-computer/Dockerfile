# The Bot's computer uses Playwright's image so Chromium, Xvfb, and their system libraries stay
# matched. Xvfb is needed by Cua Driver's optional native computer backend.
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# unzip is not in the Playwright image and bun's installer needs it. Openbox gives Cua Driver's
# foreground input route an active X11 window without adding a desktop environment.
RUN apt-get update && apt-get install -y --no-install-recommends openbox unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY agent-computer/package.json agent-computer/bun.lock ./
RUN bun install --frozen-lockfile

COPY agent-computer/src ./src

# Durable working directory. Bot-produced files that must survive replacement live here.
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

ENV PORT=4100
ENV DISPLAY=:99
# The image runs Chromium as root inside its container, matching the existing Playwright launch.
# Cua Driver otherwise refuses that browser before OpenBot can apply its own container boundary.
ENV CUA_E2E_BROWSER_NO_SANDBOX=1
EXPOSE 4100
# Readiness is exposed through Docker health so the supervisor need not know the network route.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

# `xvfb-run` waits indefinitely for its readiness signal when it is PID 1. Start the fixed private
# display and its small window manager directly. Openbox can then foreground the isolated browser
# for native keyboard/takeover input and restore focus without touching a host desktop session.
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp & until [ -S /tmp/.X11-unix/X99 ]; do sleep 0.05; done; openbox --sm-disable & export CUA_DRIVER_BROWSER_PROFILE_ROOT=\"${CUA_DRIVER_BROWSER_PROFILE_ROOT:-${PROFILES_DIR:-/profiles}/cua-driver}\"; exec bun src/index.ts"]
