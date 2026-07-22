# Development Notes

## Environment Files

Create local env files from the examples:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item packages/db/.env.example packages/db/.env
```

Then replace `SOHWE_ENCRYPTION_KEY` in `apps/api/.env` with a real 32-byte base64 key:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

`apps/worker` loads `apps/api/.env` in local dev so the API and worker share `DATABASE_URL`, `REDIS_URL`, and `SOHWE_ENCRYPTION_KEY`.

## Local Startup

```powershell
pnpm.cmd install
docker compose -f docker-compose.dev.yml up -d
pnpm.cmd db:generate
pnpm.cmd db:migrate:deploy
pnpm.cmd dev
```

Use `pnpm.cmd` if PowerShell blocks `pnpm.ps1`.

## Deploying Apps Locally

Dockerfile apps use the host Docker CLI.

Non-Dockerfile apps use Nixpacks. On Windows, install the official Nixpacks binary under:

```text
%USERPROFILE%\.nixpacks\bin\nixpacks.exe
```

The builder checks that location when `nixpacks` is not available on `PATH`.

## Schema Changes

Schema changes ship as versioned migrations in `packages/db/prisma/migrations`. After editing `packages/db/prisma/schema.prisma`:

```powershell
pnpm.cmd db:migrate --name short_description_of_change
pnpm.cmd db:generate
pnpm.cmd typecheck
```

`db:migrate` (`prisma migrate dev`) writes a new timestamped `migration.sql`, applies it to the dev database, and regenerates the client. **Commit the generated `migration.sql`** — it is the same SQL that will run on every production install via `sohwe migrate` (`prisma migrate deploy`).

Read the generated SQL before committing. Prisma emits `DROP COLUMN` / type narrowing without comment, and there are no down-migrations: `sohwe rollback` restores the previous images but does not revert schema. If a change is destructive, say so in `CHANGELOG.md`.

Avoid `pnpm db:push` now that migrations exist — it mutates the database without recording a migration, so the dev DB silently drifts from what production will replay. It remains useful only for a throwaway scratch database.

The two committed migrations are `20260722000000_init` (the schema every release up to v0.3.8 shipped) and `20260722000100_observability_and_backups` (Phase 4 + 4.5 tables). Do not renumber `init`: `sohwe migrate` baselines pre-v0.3.8 databases against that exact name.

## Roadmap Pointer

Phases 0 through 4.5 are implemented. The next milestone is **Phase 5 — git-push deploys** (GitHub App, webhook signature verification, auto-deploy on tracked-branch push).

See [`ROADMAP.md`](./ROADMAP.md) for the per-item checklist.
