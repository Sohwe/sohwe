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

One command does env files (with generated secrets), infrastructure, and
migrations — idempotent, existing values are never overwritten:

```powershell
node scripts/dev-setup.mjs
pnpm.cmd dev
```

Or manually:

```powershell
pnpm.cmd install
docker compose -f docker-compose.dev.yml up -d
pnpm.cmd db:generate
pnpm.cmd db:migrate:deploy
pnpm.cmd dev
```

Use `pnpm.cmd` if PowerShell blocks `pnpm.ps1`. (`pnpm run setup` also works;
plain `pnpm setup` hits a pnpm builtin instead.)

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

The committed migrations are `20260722000000_init` (the schema every release up to v0.3.8 shipped), `20260722000100_observability_and_backups` (Phase 4 + 4.5 tables), and `20260811111155_github_app_and_push_deploys` (Phase 5). Do not renumber `init`: `sohwe migrate` baselines pre-v0.3.8 databases against that exact name.

## Testing GitHub Push Deploys Locally

GitHub has to reach this machine, so a local instance needs a public tunnel:

```bash
cloudflared tunnel --url http://localhost:3000   # or ngrok http 3000 / tailscale funnel 3000
```

Point the tunnel at the **dashboard** (port 3000) — Vite proxies `/api` to the API, so the webhook and OAuth callbacks resolve. Then set `SOHWE_PUBLIC_URL` in `apps/api/.env` to the tunnel URL and restart `pnpm dev`.

That value is baked into the GitHub App's webhook and redirect URLs when GitHub creates the app, so it has to be right *before* you connect. Tunnel URLs change on every restart unless you have a named tunnel: with an ephemeral URL you will be deleting and recreating the test app each session. Delete stale test apps from GitHub's Developer settings.

## Roadmap Pointer

Phases 0 through 5 are implemented. The next milestone is **Phase 6 — multi-user** (invitations, role guards, audit log).

See [`ROADMAP.md`](./ROADMAP.md) for the per-item checklist.
