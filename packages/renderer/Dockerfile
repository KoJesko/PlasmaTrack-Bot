# PlasmaTrack renderer: route maps, charts and evidence-image compression for the bot.
# It runs as a Cloudflare Container behind the bot Worker (docs/DEPLOY.md §2); the
# image is built by .github/workflows/renderer-image.yml and pushed to Cloudflare's
# private registry. It works on any Docker host too.
#
# Build from the repository root (the renderer uses the core workspace):
#   docker build --platform linux/amd64 -f packages/renderer/Dockerfile -t plasmatrack-renderer .
#
# Basemaps are not in the image. On Cloudflare, the Durable Object uploads them from
# R2 when the container starts (PUT /v1/tiles/{game}). Elsewhere, mount them and set
# TILES_ETS2 / TILES_ATS.
#
# Ubuntu 24.04 because MapLibre Native's prebuilt Linux binary targets it.

FROM ubuntu:24.04

ARG NODE_VERSION=24.21.0

# xvfb gives MapLibre Native a display; Mesa's llvmpipe draws on the CPU (no GPU).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
      xvfb xauth \
      libgl1 libegl1 libopengl0 libgl1-mesa-dri libegl-mesa0 libglx-mesa0 \
      libcurl4 libuv1 libjpeg-turbo8 libpng16-16t64 libwebp7 libicu74 \
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
    TILES_DIR=/tmp/tiles \
    LIBGL_ALWAYS_SOFTWARE=1

USER ubuntu
EXPOSE 8788

# MapLibre Native needs a GL context; xvfb-run gives it a virtual display.
CMD ["xvfb-run", "-a", "node", "packages/renderer/src/main.ts"]
