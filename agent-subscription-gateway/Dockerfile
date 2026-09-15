FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS node-toolchain
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-toolchain

FROM node-toolchain AS runtime

ARG CODEX_VERSION=0.154.0
ARG CLAUDE_VERSION=2.1.271
ARG GROK_VERSION=1.0.30
ARG NPM_VERSION=12.0.2
ENV CODEX_VERSION=${CODEX_VERSION}
ENV CLAUDE_VERSION=${CLAUDE_VERSION}
ENV GROK_VERSION=${GROK_VERSION}
ENV HOME=/home/gateway

COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates git bubblewrap socat \
  && npm install --global "npm@${NPM_VERSION}" \
  && npm install --global --allow-scripts=@anthropic-ai/claude-code,@xai-official/grok "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" "@xai-official/grok@${GROK_VERSION}" \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin gateway \
  && mkdir -p /app /workspaces /var/lib/openbot-gateway /home/gateway/.codex /home/gateway/.grok /etc/codex /etc/claude-code /etc/grok \
  && chmod 0755 /etc/codex /etc/claude-code /etc/grok \
  && chown -R 10001:10001 /app /workspaces /var/lib/openbot-gateway /home/gateway

WORKDIR /app
COPY --chown=10001:10001 agent-subscription-gateway/package.json agent-subscription-gateway/package.json
COPY --chown=10001:10001 agent-subscription-gateway/src agent-subscription-gateway/src
COPY --chown=10001:10001 shared shared
COPY --chmod=0444 deploy/aws/codex-config.toml /etc/codex/config.toml
COPY --chmod=0444 deploy/aws/codex-requirements.toml /etc/codex/requirements.toml
COPY --chmod=0444 deploy/aws/claude-managed-settings.json /etc/claude-code/managed-settings.json
COPY --chmod=0444 deploy/aws/grok-requirements.toml /etc/grok/requirements.toml

USER 10001:10001
CMD ["bun", "agent-subscription-gateway/src/main.ts"]
