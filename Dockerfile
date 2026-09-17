# syntax=docker/dockerfile:1

# Pinned to the build host's own platform, not the target platform: both
# stages only run npm/tsc and produce architecture-independent JS — true only
# because scripts/check-no-native-addons.ts keeps every runtime dependency
# pure-JS — so running them under QEMU emulation for a cross-arch build wastes
# time for no benefit. Only the final "runtime" stage below actually needs to
# match the platform `docker buildx build --platform` was asked for.
FROM --platform=$BUILDPLATFORM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM --platform=$BUILDPLATFORM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime

ARG GIT_COMMIT=unknown
ARG IMAGE_VERSION=0.0.0

LABEL org.opencontainers.image.title="technitium-metrics-exporter" \
      org.opencontainers.image.description="Prometheus exporter for Technitium DNS Server" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}"

ENV GIT_COMMIT=${GIT_COMMIT} \
    NODE_ENV=production

# Fixed non-root UID/GID rather than an arbitrary assigned one, so Kubernetes
# runAsUser/runAsGroup and systemd/compose user-namespace mappings can target
# a known, stable value instead of inspecting the image first.
RUN groupadd --system --gid 10001 exporter \
    && useradd --system --uid 10001 --gid exporter --no-create-home --shell /usr/sbin/nologin exporter

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json package-lock.json ./

USER exporter:exporter

EXPOSE 10053

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD ["node", "dist/healthcheck.js"]

# Exec form: the Node process is PID 1 and receives SIGTERM directly, rather
# than a shell PID 1 that swallows it.
ENTRYPOINT ["node", "dist/index.js"]
