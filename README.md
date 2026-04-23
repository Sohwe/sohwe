# Sohwe

Sohwe is an open-source, self-hostable deployment platform (PaaS): connect a repo, deploy to your own infrastructure, and get live URLs with HTTPS, logs, and sensible defaults—without vendor lock-in. The product vision and roadmap live in [`sohwe-prd.md`](./sohwe-prd.md).

This repository is a **pnpm + Turborepo** monorepo. The detailed bootstrap and phased implementation guide is [`sohwe-getting-started.md`](./sohwe-getting-started.md).

## Current status

**v0.3.0** includes through **Phase 3 (stateful apps)** on a single machine: Nixpacks + custom domains, **encrypted env vars** (dashboard + API; worker injects at deploy), **named persistent volumes** with Docker `Binds`, **memory/CPU limits**, per-app **internal Docker network** (`sohwe_app_<id>_net` plus the Traefik network), and the same dashboard flows as before (deployments, **Browse files** — use a mount path under a volume after redeploy to verify persisted data).

Next roadmap milestone: **Phase 3.5 (packaging & install)**, then **Phase 4 (observability)**. See [`CHANGELOG.md`](./CHANGELOG.md) and [`sohwe-getting-started.md`](./sohwe-getting-started.md).

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

- **`apps/api/.env`** — API runtime (`DATABASE_URL`, `REDIS_URL`, `PORT`, `SESSION_SECRET`, `SOHWE_ENCRYPTION_KEY`, etc.). The **worker** also needs `SOHWE_ENCRYPTION_KEY` (and `DATABASE_URL` / `REDIS_URL`) to decrypt env at deploy; in local dev, `apps/worker` loads `apps/api/.env` via dotenv, so a single file is enough.
- **`packages/db/.env`** — Prisma CLI (`DATABASE_URL` for `db:push` / `db:studio`).

Use strong, unique values for secrets in any shared or deployed environment. The getting-started doc shows the expected variable names and example connection strings.

## Repository layout

| Path | Role |
| --- | --- |
| `apps/api` | Fastify HTTP API |
| `apps/dashboard` | Vite + React control plane UI |
| `apps/worker` | BullMQ consumer: git clone, build, dockerode, Traefik labels, log pub/sub |
| `packages/db` | Prisma schema and client |
| `packages/types` | Shared Zod schemas and types |
| `packages/queue` | BullMQ deploy job types and queue config (API + worker) |
| `packages/crypto` | AES-256-GCM env encryption helpers (API + worker) |
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
