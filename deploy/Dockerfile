# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${NODE_IMAGE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@9.15.9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY spikes/package.json ./spikes/package.json
COPY scripts/check-production-hooks.mjs ./scripts/check-production-hooks.mjs
RUN pnpm install --frozen-lockfile --prod=false
RUN VITE_TEST_HOOKS=0 pnpm --filter @whiteboard/app build \
    && node scripts/check-production-hooks.mjs

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.source="https://github.com/krongthamk/threejs-whiteboard"
# The shared image also supports operator jobs; no backup credentials are
# mounted in the application service. flock serializes maintenance jobs.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates restic util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY deploy/healthcheck.mjs deploy/check-storage.mjs deploy/backup.sh ./deploy/
RUN mkdir /data /backups /restore && chown node:node /data /backups /restore
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 \
    WHITEBOARD_DATA_DIR=/data/live WHITEBOARD_STATIC_DIR=/app/packages/app/dist \
    WHITEBOARD_SECURE_COOKIES=1 WHITEBOARD_TRUSTED_PROXY=1 \
    WHITEBOARD_GOOGLE_ENABLED=0 WHITEBOARD_DRAIN_MS=5000
USER node
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
    CMD ["node", "deploy/healthcheck.mjs"]
CMD ["node", "--import", "tsx", "packages/server/src/index.ts"]
