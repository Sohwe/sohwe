# syntax=docker/dockerfile:1.7
#
# Sohwe Worker — BullMQ consumer that runs deploy jobs.
#
# The runtime image bakes in:
#   - git         (used by @sohwe/worker to clone user repos)
#   - docker CLI  (used by @sohwe/builder -> `docker build`)
#   - nixpacks    (used by @sohwe/builder -> `nixpacks build`)
#
# The host only needs the Docker daemon; everything else ships in this image.

ARG NODE_VERSION=24
ARG PNPM_VERSION=9.0.0
ARG NIXPACKS_VERSION=1.29.1

############################
# Stage 1: base
############################
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm:$PATH \
    CI=true
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
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
COPY packages/queue/package.json    packages/queue/package.json
COPY packages/types/package.json    packages/types/package.json
RUN --mount=type=cache,id=pnpm-store-worker,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

############################
# Stage 3: build
############################
FROM deps AS build
COPY packages packages
COPY apps/worker apps/worker
RUN pnpm --filter @sohwe/db exec prisma generate

############################
# Stage 4: runtime (adds git, docker CLI, nixpacks)
############################
FROM base AS runtime
ARG NIXPACKS_VERSION

# Install build tooling used by user deploys:
#   - git              (source fetch)
#   - docker CLI only  (daemon lives on the host, mounted via socket)
#   - curl/gnupg/lsb   (needed to fetch and verify the Docker apt repo)
#
# The Docker apt repository publishes `docker-ce-cli` for Debian. We avoid
# `docker-ce` + `containerd` — the worker never runs its own daemon.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        git curl ca-certificates gnupg lsb-release; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg; \
    chmod a+r /etc/apt/keyrings/docker.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli; \
    apt-get purge -y --auto-remove gnupg lsb-release; \
    rm -rf /var/lib/apt/lists/*

# Install Nixpacks by fetching the release tarball directly. The upstream
# install.sh script only ever downloads "latest"; pinning the version keeps
# image builds reproducible and lets us publish multi-arch (amd64 + arm64)
# images from the same Dockerfile.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
        amd64) target="x86_64-unknown-linux-musl" ;; \
        arm64) target="aarch64-unknown-linux-musl" ;; \
        *) echo "Unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/nixpacks-v${NIXPACKS_VERSION}-${target}.tar.gz"; \
    curl -fsSL "${url}" -o /tmp/nixpacks.tar.gz; \
    tar -xzf /tmp/nixpacks.tar.gz -C /usr/local/bin nixpacks; \
    rm /tmp/nixpacks.tar.gz; \
    chmod +x /usr/local/bin/nixpacks; \
    nixpacks --version

ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/worker

# No HTTP port. The worker's liveness is "the process is running". If it
# crashes, Docker restarts it (via compose policy). A deeper health probe
# would need Redis access and isn't worth the complexity here.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
