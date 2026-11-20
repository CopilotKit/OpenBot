# The OpenBot management agent: one small process and kubectl, run unprivileged.
#
# Built from the repository root: docker build --file management-agent/Dockerfile .
#
# The agent is bundled into one file in the first stage, so the image carries no node_modules.
# kubectl is the official binary, checked against its published SHA-256.

# oven/bun:1.4.3-slim, pinned.
FROM oven/bun@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY app/package.json app/package.json
COPY shared/package.json shared/package.json
COPY extension/package.json extension/package.json
COPY management-agent/package.json management-agent/package.json
RUN bun install --frozen-lockfile --ignore-scripts --production \
      --filter @openbot/shared --filter @openbot/management-agent
COPY shared/management-contract.ts shared/kubernetes-promotion.ts shared/release-manifest.ts shared/
COPY management-agent/src management-agent/src
ARG AGENT_VERSION=0.1.0
RUN bun build management-agent/src/main.ts --target bun \
      --define "process.env.OPENBOT_AGENT_VERSION=\"${AGENT_VERSION}\"" \
      --outfile /out/agent.js

FROM oven/bun@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS kubectl
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.37.2
ARG KUBECTL_SHA256_AMD64=c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4
ARG KUBECTL_SHA256_ARM64=fcc16f63186659d9722014b7e02d5fdd2d4e669cb8c0ab66365d7d3b8ba03509
ADD https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl /kubectl
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) expected="${KUBECTL_SHA256_AMD64}" ;; \
      arm64) expected="${KUBECTL_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture ${TARGETARCH}"; exit 1 ;; \
    esac; \
    echo "${expected}  /kubectl" | sha256sum -c -; \
    chmod 0755 /kubectl

FROM oven/bun@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
# The repository this image is built from, as every published OpenBot image names it.
LABEL org.opencontainers.image.source="https://github.com/CopilotKit/OpenBot"
COPY --from=kubectl /kubectl /usr/local/bin/kubectl
COPY --from=build /out/agent.js /app/agent.js
# Not root, and no shell needed at run time.
# kubectl keeps its discovery cache under $HOME; /tmp is the writable volume.
ENV HOME=/tmp
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["bun", "/app/agent.js"]
