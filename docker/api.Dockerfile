# syntax=docker/dockerfile:1.7
#
# Sohwe API — Fastify HTTP service.
#
# Runtime note: the monorepo's workspace packages (@sohwe/db, @sohwe/queue, ...)
# export TypeScript source directly via `"main": "./src/index.ts"`. A plain
# `node dist/index.js` can't resolve those. We run the app through `tsx` at
# runtime, which keeps dev/prod parity and avoids a bundler decision this phase.

ARG NODE_VERSION=24
ARG PNPM_VERSION=9.0.0
ARG SOHWE_VERSION=dev

############################
# Stage 1: base
############################
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm:$PATH \
    CI=true
# openssl + ca-certificates: required by Prisma's query engine on debian-slim.
# tini: small PID 1 so SIGTERM/SIGINT propagate cleanly to Node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

############################
# Stage 2: deps (cache-friendly install from manifests only)
############################
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json          apps/api/package.json
COPY apps/worker/package.json       apps/worker/package.json
COPY apps/dashboard/package.json    apps/dashboard/package.json
COPY packages/backups/package.json  packages/backups/package.json
COPY packages/builder/package.json  packages/builder/package.json
COPY packages/bundler/package.json  packages/bundler/package.json
COPY packages/crypto/package.json   packages/crypto/package.json
COPY packages/db/package.json       packages/db/package.json
COPY packages/github/package.json   packages/github/package.json
COPY packages/queue/package.json    packages/queue/package.json
COPY packages/types/package.json    packages/types/package.json
RUN --mount=type=cache,id=pnpm-store-api,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

############################
# Stage 3: build (generate Prisma client; no tsc needed, tsx runs source)
############################
FROM deps AS build
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @sohwe/db exec prisma generate

############################
# Stage 4: runtime
############################
FROM base AS runtime
ARG SOHWE_VERSION
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    SOHWE_VERSION=${SOHWE_VERSION}
COPY --from=build /app /app
WORKDIR /app/apps/api
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
