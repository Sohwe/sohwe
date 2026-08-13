# syntax=docker/dockerfile:1.7
#
# Sohwe Dashboard — Vite + React SPA served by nginx.
#
# nginx also reverse-proxies `/api/*` and `/health` to the api container, so
# the browser sees a single origin. This avoids CORS entirely and lets session
# cookies work without cross-site complications.

ARG NODE_VERSION=24
ARG PNPM_VERSION=9.0.0
ARG NGINX_VERSION=1.27-alpine

############################
# Stage 1: base (node + pnpm for the build)
############################
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

############################
# Stage 2: deps
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
RUN --mount=type=cache,id=pnpm-store-dashboard,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

############################
# Stage 3: build the SPA
############################
FROM deps AS build
# Same-origin /api is served by nginx in the runtime image. Default is an empty
# base (relative URLs). Pass --build-arg VITE_API_URL= only for split-origin builds.
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
COPY packages packages
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @sohwe/dashboard build

############################
# Stage 4: runtime (nginx)
############################
FROM nginx:${NGINX_VERSION} AS runtime
COPY docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
CMD ["nginx", "-g", "daemon off;"]
