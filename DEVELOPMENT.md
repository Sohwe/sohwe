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

## Roadmap Pointer

The next milestone is Phase 4 observability:

- Runtime logs in the dashboard.
- Last-deploy build logs in a dedicated UI.
- Live CPU/memory per app.
- Crash webhook alerts.
