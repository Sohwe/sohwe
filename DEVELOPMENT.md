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
pnpm.cmd db:push
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

There is no Prisma migrations directory. `pnpm db:push` is the dev workflow, and production upgrades run `prisma db push --accept-data-loss` too (via `sohwe migrate`). After changing `packages/db/prisma/schema.prisma`, run `pnpm db:generate` and `pnpm typecheck`.

## Roadmap Pointer

Phases 0 through 4.5 are implemented. The next milestone is **Phase 5 — git-push deploys** (GitHub App, webhook signature verification, auto-deploy on tracked-branch push).

See [`ROADMAP.md`](./ROADMAP.md) for the per-item checklist.
