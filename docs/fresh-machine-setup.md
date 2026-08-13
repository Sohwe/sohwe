# Setting up Sohwe on a fresh machine

This walks you from a brand-new computer — nothing installed — to a running
local Sohwe instance: dashboard, API, worker, and a first deployed app. It
covers Windows, macOS, and Linux.

This is the **development** setup (running from source). To install Sohwe on a
server for real use, see [Install on a server](../README.md#install-on-a-server-production)
instead — that path is a single installer command on a fresh Ubuntu host.

## 1. Install the prerequisites

You need four things: **Git**, **Node.js 24+**, **pnpm 9**, and **Docker**.
This is the only manual part — everything after it is one command.

### Windows

1. **Git** — install [Git for Windows](https://git-scm.com/download/win) with
   default options.
2. **Node.js 24** — install from [nodejs.org](https://nodejs.org/) (choose the
   current 24.x release), or use [nvm-windows](https://github.com/coreybutler/nvm-windows):
   `nvm install 24 && nvm use 24`.
3. **pnpm 9** — the repo pins `pnpm@9` via the `packageManager` field, so the
   simplest route is corepack, which ships with Node:

   ```powershell
   corepack enable
   ```

   Afterwards `pnpm` resolves to the pinned version automatically inside the
   repo. If PowerShell refuses to run `pnpm.ps1` because of execution policy,
   use `pnpm.cmd` everywhere you see `pnpm` below.
4. **Docker Desktop** — install
   [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
   with the **WSL 2** backend (the installer sets this up; it may ask you to
   reboot). Start Docker Desktop and wait until it reports "running".

### macOS

```bash
# Homebrew, if you don't have it: https://brew.sh
brew install git node@24
corepack enable
brew install --cask docker   # Docker Desktop; launch it once so the daemon runs
```

### Linux (Ubuntu/Debian shown)

```bash
sudo apt-get update && sudo apt-get install -y git curl
# Node 24 via nvm (or your distro's NodeSource packages)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL && nvm install 24
corepack enable
# Docker Engine + compose plugin: https://docs.docker.com/engine/install/
# then let your user run docker without sudo:
sudo usermod -aG docker "$USER" && newgrp docker
```

## 2. Clone and run setup

```bash
git clone https://github.com/Sohwe/sohwe.git
cd sohwe
node scripts/dev-setup.mjs
```

That one command does the rest:

1. **Checks the prerequisites** — Node version, git, pnpm (activating it via
   corepack if needed), Docker, and that the Docker daemon is actually
   running. A missing tool stops the script with a pointer back to step 1.
2. **Installs dependencies** — `pnpm install`.
3. **Prepares the env files** — creates `apps/api/.env` and `packages/db/.env`
   from their tracked examples and generates real secrets (`SESSION_SECRET`,
   `SOHWE_ENCRYPTION_KEY`). Values you have already configured are never
   touched — only missing files are created and only `change-me` placeholders
   are filled, so re-running is always safe.
4. **Starts the dev infrastructure** — Postgres 16, Redis 7, and Traefik v3
   via `docker compose -f docker-compose.dev.yml up -d`, then waits for
   Postgres to accept connections.
5. **Prepares the database** — `pnpm db:generate` and
   `pnpm db:migrate:deploy`.

The script is idempotent — re-run it any time. `pnpm run setup` does the same
thing once dependencies exist (note: plain `pnpm setup` is a pnpm builtin and
does something else). Flags for partial runs: `--skip-install`,
`--skip-infra`, `--skip-migrate`.

## 3. Run it

```bash
pnpm dev
```

Turborepo starts all three services:

- **Dashboard** — <http://localhost:3000>
- **API** — <http://localhost:3001> (try `GET /health`)
- **Worker** — no port; it consumes the deploy queue

Open <http://localhost:3000>. There is no installer password locally (the setup
gate only activates when `SOHWE_SETUP_PASSWORD` is set), so the first visit
goes straight to first-run setup: create the owner account and organization,
and you are signed in.

## 4. Deploy your first app

1. Click **New app**, give it a name, and point it at a public Git repository
   (anything with a root `Dockerfile` is the simplest first test).
2. Deploy. Build logs stream live in the deployment view.
3. When it's running, the app is served by Traefik at
   `http://<slug>.sohwe.localhost` — browsers resolve `*.localhost` to your own
   machine, so this works with no DNS or hosts-file changes.

Two things must be true for deploys to work: **Docker is running** (the worker
builds images and runs containers through it) and **the worker is running**
(it's part of `pnpm dev`; without it deployments sit in `pending` forever).

### Apps without a Dockerfile (Nixpacks)

Repos with no root `Dockerfile` build with [Nixpacks](https://nixpacks.com) in
`auto` mode, which requires the `nixpacks` CLI on your machine (the setup
script warns if it's missing, but doesn't require it):

- **macOS / Linux**: `curl -sSL https://nixpacks.com/install.sh | bash`
- **Windows**: download `nixpacks.exe` from the
  [releases page](https://github.com/railwayapp/nixpacks/releases) and place it
  at `%USERPROFILE%\.nixpacks\bin\nixpacks.exe` (the builder checks there when
  `nixpacks` is not on `PATH`), or anywhere on `PATH`.

## 5. Optional: GitHub push deploys locally

Deploy-on-push needs GitHub to reach your machine, so a local instance needs a
public tunnel (cloudflared, ngrok, or tailscale funnel) pointed at the
**dashboard** on port 3000. Set `SOHWE_PUBLIC_URL` in `apps/api/.env` to the
tunnel URL *before* connecting GitHub — it is baked into the GitHub App when
GitHub creates it. Details and caveats: [DEVELOPMENT.md](../DEVELOPMENT.md#testing-github-push-deploys-locally).

## Manual setup (what the script does, step by step)

Prefer to do it by hand, or need to redo one piece? These are exactly the
steps `scripts/dev-setup.mjs` automates.

1. **Install dependencies**: `pnpm install`
2. **Start infrastructure**: `docker compose -f docker-compose.dev.yml up -d`
   — publishes Postgres on `localhost:5432` (db `sohwe_dev`, user `sohwe`,
   password `password`), Redis on `localhost:6379`, and Traefik on ports
   **80**, **443**, and **8080** (its own dashboard).
3. **Create env files**: copy `apps/api/.env.example` to `apps/api/.env` and
   `packages/db/.env.example` to `packages/db/.env`, then edit `apps/api/.env`
   and replace the two placeholder secrets:
   - `SESSION_SECRET` — any long random string (16 characters minimum).
   - `SOHWE_ENCRYPTION_KEY` — exactly 32 random bytes, base64-encoded:
     `openssl rand -base64 32` (macOS/Linux) or on Windows
     `[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))`.

   The defaults for `DATABASE_URL` and `REDIS_URL` already match the compose
   containers. The worker loads `apps/api/.env` in local dev, so one file
   covers both services — which also guarantees the API and worker share the
   same `SOHWE_ENCRYPTION_KEY` (they must, or deploys cannot decrypt env
   vars). The API validates all of this at boot and refuses to start with a
   clear message if a secret is missing or malformed.
4. **Prepare the database**: `pnpm db:generate`, then `pnpm db:migrate:deploy`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `pnpm` fails with an execution-policy error (Windows) | Use `pnpm.cmd` instead of `pnpm`. |
| API exits at boot complaining about `SESSION_SECRET` / `SOHWE_ENCRYPTION_KEY` | Re-run `node scripts/dev-setup.mjs` — it fills missing/placeholder secrets in place. The key must be 32 bytes, base64-encoded; the session secret at least 16 chars. |
| Traefik container restarts or ports clash | Something else owns port 80/443/8080. Free it (on Windows check IIS / other dev servers), then re-run the setup script. |
| Deployment stuck in `pending` | The worker isn't running. It starts with `pnpm dev`; check that terminal for a crash (usually a bad `DATABASE_URL`/`REDIS_URL` or Docker not running). |
| Build fails with `nixpacks` not found | The repo has no root `Dockerfile`, so the build needs the Nixpacks CLI — see step 4. |
| `http://<slug>.sohwe.localhost` doesn't resolve | Modern browsers resolve `*.localhost` locally; `curl` and some tools don't. Use `curl -H "Host: <slug>.sohwe.localhost" http://localhost` or add a hosts-file entry. |
| Deploys fail to decrypt env vars | API and worker are using different `SOHWE_ENCRYPTION_KEY` values. In local dev both read `apps/api/.env`, so this only happens if you created a separate worker env file. |

## Where to go next

- [DEVELOPMENT.md](../DEVELOPMENT.md) — dev-only gotchas, schema-change workflow
- [README.md](../README.md) — production install, env var reference, repo layout
- [sohwe-getting-started.md](../sohwe-getting-started.md) — architecture and design decisions
