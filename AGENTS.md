# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

Sohwe is an open-source, self-hostable deployment platform/PaaS. It lets users create apps from Git repositories, build them with Dockerfile or Nixpacks, run them as Docker containers, route traffic through Traefik, and manage deployments, env vars, volumes, and files from a React dashboard.

The source of truth for product direction and architecture is:

- `README.md` - current status, install/development workflow, repo map
- `sohwe-getting-started.md` - architecture and phased implementation guide
- `sohwe-prd.md` - product requirements and roadmap
- `CHANGELOG.md` - released and unreleased behavior changes

`apps/dashboard/README.md` is still the default Vite template and should not be treated as project-specific documentation.

## Repository Shape

This is a pnpm 9 + Turborepo monorepo. Node.js 24+ is required.

- `apps/api` - Fastify API, auth/session handling, application CRUD, deploy enqueueing, SSE logs, Docker cleanup/file APIs
- `apps/dashboard` - Vite + React SPA using TanStack Router/Query, Tailwind, Radix/shadcn-style UI, lucide icons, sonner
- `apps/worker` - BullMQ deploy consumer; clones repos, builds images, starts Docker containers, applies Traefik labels, injects decrypted env, manages volumes/networks
- `packages/db` - Prisma schema and client
- `packages/types` - shared Zod schemas, inferred types, and Docker resource naming helpers
- `packages/queue` - BullMQ queue/job helpers and Redis config
- `packages/builder` - Dockerfile/Nixpacks image build wrapper
- `packages/crypto` - AES-256-GCM helpers for encrypted env vars
- `docker/` - production Dockerfiles and dashboard nginx config
- `docker-compose.dev.yml` - local Postgres, Redis, Traefik
- `docker-compose.prod.yml` and `docker-compose.https.yml` - production stack
- `scripts/install.sh` and `scripts/sohwe` - production installer and host CLI

## Commands

Use pnpm from the repository root unless a narrower filter is useful.

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d
pnpm db:generate
pnpm db:push
pnpm dev
```

Validation commands:

```bash
pnpm build
pnpm typecheck
pnpm lint
```

Database commands:

```bash
pnpm db:generate
pnpm db:push
pnpm db:studio
```

There are currently no test scripts in the workspace packages. If adding tests, add package scripts and document the new command here and in `README.md`.

## Environment

Local infrastructure is Postgres 16, Redis 7, and Traefik v3 from `docker-compose.dev.yml`.

Expected env files:

- `apps/api/.env` - API runtime variables such as `DATABASE_URL`, `REDIS_URL`, `PORT`, `SESSION_SECRET`, `SOHWE_ENCRYPTION_KEY`, `SOHWE_BASE_DOMAIN`, `SOHWE_HTTPS_ENABLED`, and `SOHWE_CERT_RESOLVER`
- `packages/db/.env` - Prisma CLI `DATABASE_URL`

The worker loads env from several locations, including `apps/api/.env`, so local development usually uses the same database, Redis, and encryption key as the API.

Do not commit real secrets or generated env files.

## Implementation Rules

### Shared Contracts

- Put request/response validation schemas that cross API/dashboard boundaries in `packages/types/src/index.ts`.
- Prefer Zod schemas from `@sohwe/types` in Fastify route schemas and parse request bodies with the same schema when needed.
- Keep workspace imports through package names such as `@sohwe/types`, `@sohwe/db`, `@sohwe/queue`, `@sohwe/crypto`, and `@sohwe/builder`.
- Keep TypeScript strictness intact. The root `tsconfig.base.json` enables `strict`, `isolatedModules`, and `noUncheckedIndexedAccess`.

### API

- API routes are registered from `apps/api/src/index.ts`; route modules live under `apps/api/src/routes`.
- Protected routes should use `authPreHandler` from `apps/api/src/session.ts` and scope data by `req.user!.organizationId`.
- Do not return `Application.envVarsEncrypted` from general application endpoints. Use `defaultApplicationSelect` and `serializeAppListRow` from `apps/api/src/app-public.ts` unless there is a deliberate secret-specific route.
- Mutating env routes should avoid logging sensitive request bodies. Preserve the existing silent logging pattern if editing those routes.
- BigInt values such as volume `sizeBytes` must be serialized before JSON responses.
- SSE deploy logs use Redis pub/sub plus stored `Deployment.buildLogs`; preserve replay behavior for reconnects.

### Worker and Docker

- The worker is the only service that performs deploy execution: git clone, image build, Docker container create/start, volume creation, per-app network creation, and deployment status transitions.
- Build mode semantics live in `packages/builder`: `auto` uses Dockerfile when present, otherwise Nixpacks; `dockerfile` requires a root Dockerfile; `nixpacks` always uses Nixpacks.
- Preserve Docker naming helpers from `@sohwe/types`:
  - volumes: `sohwe_app_<appId>_<volumeId>`
  - internal networks: `sohwe_app_<appId>_net`
- Managed Docker resources should keep Sohwe labels such as `sohwe.managed`, `sohwe.app`, `sohwe.volume`, and `sohwe.deployment`.
- Containers are attached to the Traefik network and then to a per-app internal bridge network. Do not remove that isolation accidentally.
- Env vars are encrypted at rest and decrypted only for Docker `Env` injection. Never write plaintext env values to build logs, runtime logs, API list responses, or error messages.
- Custom domain/HTTPS behavior is controlled by `SOHWE_HTTPS_ENABLED`, `SOHWE_CERT_RESOLVER`, `SOHWE_BASE_DOMAIN`, and `TRAEFIK_DOCKER_NETWORK`.

### Database

- Prisma schema is `packages/db/prisma/schema.prisma`.
- In development, use `pnpm db:push`; production install currently runs Prisma commands from the installer/CLI path.
- After schema changes, run `pnpm db:generate` and at least `pnpm typecheck`.
- Be careful with destructive schema/data changes. This project is a deployment platform and user app configuration is stateful.

### Dashboard

- Dashboard routes are manually composed in `apps/dashboard/src/router.tsx`.
- Use the `@` alias for dashboard source imports.
- API helpers live in `apps/dashboard/src/lib/api.ts`; keep `credentials: "include"` for cookie auth.
- In dev, Vite proxies `/api` to `http://127.0.0.1:3001`. Production dashboard images serve same-origin `/api` through nginx, so do not add CORS-dependent frontend behavior unless required.
- Reuse existing UI primitives in `apps/dashboard/src/components/ui` and common/layout components before adding new ones.
- Use lucide icons where an icon button is appropriate.
- Keep the UI dense and operational. Sohwe is a control plane, not a marketing site.

### Installer and Production Files

- `scripts/install.sh`, `scripts/sohwe`, production compose files, and Dockerfiles are part of the product surface. Treat changes here as user-facing and update `README.md`/`CHANGELOG.md` when behavior changes.
- The installer targets fresh Ubuntu 22.04/24.04 hosts and writes state under `/etc/sohwe/`.
- Production images are published to GHCR by `.github/workflows/release.yml` on `v*` tags.

## Documentation Expectations

Update docs when behavior changes:

- `README.md` for install/dev commands, environment variables, current status, and repo layout
- `sohwe-getting-started.md` for architecture, phase scope, or implementation flow changes
- `sohwe-prd.md` for product requirement or roadmap changes
- `CHANGELOG.md` for notable fixes, additions, and breaking changes

Keep docs consistent with the current phase language. The repo currently includes v0.3.x behavior plus unreleased Phase 3.5 packaging/install work.

## Verification Checklist

Before handing off a code change, run the narrowest meaningful checks:

- Type/schema/shared logic: `pnpm typecheck`
- Dashboard UI changes: `pnpm --filter @sohwe/dashboard lint` and `pnpm --filter @sohwe/dashboard build`
- API/worker/shared package changes: `pnpm build` or the affected package `build` scripts
- Prisma schema changes: `pnpm db:generate` and `pnpm --filter @sohwe/db typecheck`
- Installer/compose/Docker changes: inspect relevant compose/Dockerfile paths and update docs/changelog

If a check cannot run because Docker, env files, database, or network access is unavailable, state that clearly in the final response.
