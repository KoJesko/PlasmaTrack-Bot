# PlasmaTrack renderer: route maps and charts for the bot (docs/DEPLOY.md §2).
#
# Build from the repository root (the renderer uses the core workspace):
#   docker build -f packages/renderer/Dockerfile -t plasmatrack-renderer .
# Run (basemaps mounted read-only; RENDERER_KEY must equal the Worker's secret):
#   docker run -d --name plasmatrack-renderer --restart unless-stopped \
#     -e RENDERER_KEY=... -p 127.0.0.1:8788:8788 \
#     -v /srv/plasmatrack/tiles:/tiles:ro plasmatrack-renderer
#
# Ubuntu 24.04 because MapLibre Native's prebuilt Linux binary targets it.

FROM ubuntu:24.04

ARG NODE_VERSION=24.21.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
      xvfb xauth \
      libcurl4 libuv1 libjpeg-turbo8 libpng16-16t64 libwebp7 libicu74 libopengl0 libgl1 libegl1 \
 && rm -rf /var/lib/apt/lists/*

# Node.js from nodejs.org, checked against its published SHA-256.
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported: $arch"; exit 1 ;; esac; \
    file="node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${file}"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${file}\$" | sha256sum -c -; \
    tar -xJf "$file" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "$file"; \
    node --version

WORKDIR /app

# Manifests first, so dependency layers are cached between source changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/renderer/package.json packages/renderer/
COPY packages/worker/package.json packages/worker/
RUN npm ci --omit=dev -w @plasmatrack/renderer --include-workspace-root=false \
 && npm cache clean --force

COPY LICENSE.md NOTICE THIRD_PARTY_NOTICES.md ./
COPY packages/core/src packages/core/src
COPY packages/renderer/src packages/renderer/src
COPY packages/renderer/assets packages/renderer/assets

ENV NODE_ENV=production \
    RENDERER_HOST=0.0.0.0 \
    RENDERER_PORT=8788 \
    TILES_ETS2=/tiles/ets2.pmtiles \
    TILES_ATS=/tiles/ats.pmtiles

USER ubuntu
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:8788/healthz || exit 1

# MapLibre Native needs a GL context; xvfb-run gives it a virtual display.
CMD ["xvfb-run", "-a", "node", "packages/renderer/src/main.ts"]
