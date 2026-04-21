# Sohwe

Sohwe is an open-source, self-hostable deployment platform (PaaS): connect a repo, deploy to your own infrastructure, and get live URLs with HTTPS, logs, and sensible defaults—without vendor lock-in. The product vision and roadmap live in [`sohwe-prd.md`](./sohwe-prd.md).

This repository is a **pnpm + Turborepo** monorepo. The detailed bootstrap and phased implementation guide is [`sohwe-getting-started.md`](./sohwe-getting-started.md).

## Current status

**Phase 0 (foundation)** is in place: monorepo, Postgres schema (Prisma), Fastify API with first-run setup and session auth, a minimal dashboard (setup → login → empty shell), and Docker Compose for Postgres, Redis, and Traefik. Deploy pipelines and the worker arrive in later phases.

## Requirements

- **Node.js** 24+ (see `.nvmrc`)
- **pnpm** 9 (`packageManager` in root `package.json`)
- **Docker** (for local Postgres, Redis, Traefik)

## Quick start

1. **Install dependencies**

   ```bash
   pnpm install
   ```

2. **Start infrastructure**

   ```bash
   docker compose -f docker-compose.dev.yml up -d
   ```

3. **Configure environment**

   Copy or create `.env` files where the apps expect them (see [Environment](#environment)). At minimum you need a valid `DATABASE_URL` pointing at the Compose Postgres database (`sohwe_dev` by default), plus `SESSION_SECRET` and `SOHWE_ENCRYPTION_KEY` for the API.

4. **Database**

   ```bash
   pnpm db:generate
   pnpm db:push
   ```

5. **Run apps**

   ```bash
   pnpm dev
   ```

   - Dashboard: [http://localhost:3000](http://localhost:3000)
   - API: [http://localhost:3001](http://localhost:3001) (e.g. `GET /health`)

   On first visit, complete setup to create the owner and organization, then sign in.

## Environment

- **`apps/api/.env`** — API runtime (`DATABASE_URL`, `REDIS_URL`, `PORT`, `SESSION_SECRET`, `SOHWE_ENCRYPTION_KEY`, etc.).
- **`packages/db/.env`** — Prisma CLI (`DATABASE_URL` for `db:push` / `db:studio`).

Use strong, unique values for secrets in any shared or deployed environment. The getting-started doc shows the expected variable names and example connection strings.

## Repository layout

| Path | Role |
| --- | --- |
| `apps/api` | Fastify HTTP API |
| `apps/dashboard` | Vite + React control plane UI |
| `apps/worker` | Worker placeholder (used in later phases) |
| `packages/db` | Prisma schema and client |
| `packages/types` | Shared Zod schemas and types |
| `packages/queue` | Queue definitions placeholder (later phases) |
| `docker-compose.dev.yml` | Local Postgres, Redis, Traefik |

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Run all packages’ `dev` tasks via Turborepo |
| `pnpm build` | Production build |
| `pnpm lint` | Lint |
| `pnpm typecheck` | Typecheck |
| `pnpm db:generate` | `prisma generate` |
| `pnpm db:push` | Push schema to the database (dev) |
| `pnpm db:studio` | Open Prisma Studio |

## Documentation

- [`sohwe-prd.md`](./sohwe-prd.md) — Product requirements and release plan  
- [`sohwe-getting-started.md`](./sohwe-getting-started.md) — Architecture and step-by-step implementation  

## License

The product is planned as **AGPL-3.0** (see `sohwe-prd.md`). Add a `LICENSE` file at the repo root when you are ready to publish.
