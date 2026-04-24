# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### Fixed

- **Installer** — fresh-install failures surfaced during v0.3.5 VPS testing:
  - `curl | bash` no longer dies with `/usr/bin/bash: cannot execute binary file` when re-execing under `sudo`. Piped runs now re-download the installer to a temp file before `sudo -E bash`'ing it, because `$0` is the interpreter — not a readable script path — in that scenario.
  - `scripts/install.sh` now creates `/etc/sohwe/` up front (inside `fetch_assets`), fixing `mv: ... No such file or directory` on first run where the env-file step (which used to be the only `mkdir`) hadn't executed yet.
- **`sohwe` CLI** — `sohwe up` and `sohwe restart` now actually apply pending `sohwe.env` / compose-overlay edits. `restart` was a plain `docker compose restart`, which only bounces running containers with their existing config and silently ignored operator edits (e.g. toggling the HTTPS overlay). Both commands now run `docker compose up -d` (reconfigures + recreates only what changed) and then bounce Traefik, matching the existing `update` / `rollback` safeguard against stale Traefik router tables after label changes.

### Added

- **Phase 3.5 — Packaging & Install.** A fresh Ubuntu 22.04 or 24.04 VPS can now be turned into a working Sohwe instance with `curl -fsSL https://raw.githubusercontent.com/NanaAb-116/sohwe/main/scripts/install.sh | bash`.
  - **Production Dockerfiles** in `docker/` — multi-stage, `node:24-slim` base, Prisma client generated at build time. `api.Dockerfile` runs Fastify via `tsx`; `worker.Dockerfile` bakes in `git`, `docker-ce-cli`, and a pinned `nixpacks` release so the host only needs Docker; `dashboard.Dockerfile` builds the Vite SPA and serves it with `nginx:alpine`.
  - **`docker/dashboard.nginx.conf`** — same-origin serving: static assets + SPA fallback, plus `/api` and `/health` reverse-proxied to the `api` service (eliminates CORS, keeps session cookies first-party, forwards SSE/WebSocket headers for upcoming log streaming).
  - **`docker-compose.prod.yml`** — `api` + `worker` + `dashboard` + `postgres:16-alpine` + `redis:7-alpine` + `traefik:v3.1`, split across `sohwe_proxy` (public; Traefik + dashboard + managed user apps) and `sohwe_internal` (control plane). Traefik dashboard is disabled, Docker socket is mounted read-only, and Let's Encrypt HTTP-01 is pre-wired.
  - **`docker-compose.https.yml`** — optional overlay that flips the dashboard router to `websecure` with a Let's Encrypt cert and an HTTP→HTTPS redirect. Applied automatically when the operator provides a domain + email at install time.
  - **`scripts/install.sh`** — idempotent installer. Detects Ubuntu 22.04/24.04, installs Docker Engine + compose plugin from Docker's apt repo, collects an optional domain/email (via `/dev/tty` so `curl | bash` still prompts), generates `/etc/sohwe/sohwe.env` with random 32-byte `SESSION_SECRET`, `SOHWE_ENCRYPTION_KEY`, and Postgres password (chmod 600), downloads compose files + the `sohwe` CLI, runs `prisma migrate deploy`, prints the dashboard URL.
  - **`sohwe` CLI** at `/usr/local/bin/sohwe` — `up`, `down`, `restart`, `status`, `logs`, `pull`, `migrate`, `update [version]`, `rollback`, `version`, `env`. `update` pulls the new images, refreshes compose files, runs migrations, and stashes the previous version in `/etc/sohwe/.previous-version` so `sohwe rollback` works for one hop. Rollback intentionally does *not* reverse Prisma migrations.
  - **`.github/workflows/release.yml`** — on every `v*` tag (and manual dispatch), builds and pushes multi-arch (`linux/amd64` + `linux/arm64`) images to `ghcr.io/nanaab-116/sohwe-{api,worker,dashboard}:<tag>` (GHCR lowercases the owner segment). `latest` moves only for stable semver tags (skips `-rc`, `-beta`, etc.). Uses GitHub Actions layer cache per image.
  - **Root `.dockerignore`** — keeps build contexts small; excludes `node_modules`, `dist`, `.turbo`, `.env*`, docs, and the compose files themselves.

### Changed

- **Dashboard** — Complete UI revamp: Render-style **shell** (collapsible sidebar + top bar + breadcrumbs), **TanStack Router** URL routes (`/apps`, `/apps/:id/overview|deployments|variables|volumes|files|settings`, deploy log at `/apps/:id/deployments/:deploymentId`), **shadcn-style** Radix primitives (cards, dialogs, sheets, tables, tabs, toasts), light/dark **theme** toggle, **sonner** notifications, responsive app cards, deployment log in a **slide-over sheet**, env editor with **bulk .env paste**, and confirm dialogs instead of `window.confirm`.

## [0.3.0] - 2026-04-23

**Phase 3 (stateful apps)** — encrypted environment variables, persistent named volumes, per-app memory/CPU limits, and a per-app isolated internal Docker network. Dashboard **Settings** adds env + volumes + resource limits; API responses no longer include ciphertext (`envVarsEncrypted`).

### Added

- **`@sohwe/crypto`** — AES-256-GCM helpers (`encryptJson` / `decryptJson` / `maskedPreview` / `toDockerEnvList`) for `envVarsEncrypted` and shared use in API + worker.
- **API** — `GET/PUT/PATCH /api/applications/:id/env` (masked list by default; `?reveal=true` for plaintext; `logLevel: silent` on mutating env routes). `POST/GET/DELETE /api/applications/:id/volumes` and `.../volumes/:volumeId` for named volume rows; Docker volume name `sohwe_app_<appId>_<volumeId>`. `PATCH /api/applications/:id` accepts `memoryLimitMb` and `cpuLimit` (nullable).
- **API responses** — `GET` applications use an explicit `select` so `envVarsEncrypted` is never returned; `sizeBytes` on volumes is JSON-safe (string). Build log SSE no longer loads full `Application` (no secret column in memory for that request).
- **Worker** — decrypts env into `Env:`, pre-creates/labels named volumes and sets `Binds`, applies `HostConfig.Memory` / `NanoCpus`, `unless-stopped` unchanged; after start, ensures `sohwe_app_<appId>_net` (internal bridge) exists and connects the app container. **Delete application** stops containers, removes Docker named volumes for each Prisma `Volume` row, removes the per-app network, then deletes the DB row.
- **Dashboard** — env panel (add/remove, masked list, “Show / edit all values”, PUT/PATCH), volumes panel (add path + optional size hint, remove with confirm), memory (MB) + CPU (cores) in settings form.

### Notes

- **`SOHWE_ENCRYPTION_KEY`** must be set for the **worker** as well as the API (same 32-byte base64 value) so deploy can decrypt env for `docker create`.

## [0.2.0] - 2026-04-23

**Phase 2 (broad runtime support)** — Nixpacks auto-detection, per-app build/start command overrides, editable settings, custom domains with opt-in HTTPS via Traefik + Let's Encrypt. Also lands small pre-Phase-2 polish (deployments table, Phase 3 docs cleanup) and re-scopes the install script / self-update work to a new **Phase 3.5 — Packaging & Install** section in the roadmap.

### Added

- **Nixpacks** — `@sohwe/builder` now dispatches between `docker build` and `nixpacks build` via `buildAppImage({ mode, ... })`. In `auto` mode a Dockerfile wins; otherwise Nixpacks auto-detects Next.js / Node / Python / Go / Rust / static sites with no Dockerfile. The worker passes `buildCmd` / `startCmd` through to `nixpacks --build-cmd` / `--start-cmd`.
- **API** — `CreateApplicationSchema` persists the real `buildMode` (was hardcoded to `dockerfile`). New `PATCH /api/applications/:id` accepts partial updates to `buildMode`, `buildCmd`, `startCmd`, `domain`, `gitBranch`, `port`, `name`; validated by `UpdateApplicationSchema` in `@sohwe/types`.
- **Custom domains + HTTPS** — worker emits a `websecure` Traefik router and an HTTP→HTTPS redirect middleware when `SOHWE_HTTPS_ENABLED=true` and an app has a real public domain. `.localhost` / `.local` hosts stay HTTP-only so local dev is unchanged. Cert resolver is configurable with `SOHWE_CERT_RESOLVER` (defaults to `letsencrypt`).
- **Traefik** — `docker-compose.dev.yml` gains a `websecure` entrypoint on `:443`, a named `traefik_acme` volume for `acme.json`, and an opt-in Let's Encrypt resolver (`SOHWE_ACME_EMAIL`). The resolver only activates for containers that explicitly request it, so `up -d` still works unchanged for local `.localhost` work.
- **Dashboard** — new-app form adds build mode, build/start command overrides, and custom domain. Each app row shows a build-mode badge, its custom domain (if any), and a **Settings** panel that PATCHes the app (build mode, overrides, domain, branch, port).
- **Deployments** — Table per app (Vercel-style): short deployment id, **Current** on the active successful build, status + duration, branch, short **git SHA** + **commit subject** (one line, truncated), relative time, **Log** and per-row **Roll back** to any older successful build.
- **Schema** — `Deployment.commitMessage` (text), set at build time with `git log -1 --pretty=format:%s` (capped at 2k chars). Rollback/promote copies `commitMessage` and `commitSha` from the source deployment.

### Changed

- **Roadmap** — added **Phase 3.5 — Packaging & Install** to `sohwe-getting-started.md` (production Dockerfiles, `docker-compose.prod.yml`, published multi-arch images, `curl | bash` installer, `sohwe update`). PRD §10.1 re-tags install-script and self-update from `[P1]` to `[P3.5]`; §12.1 adds M3.5 at Week 6; §15 Open Question #1 (install distribution) marked **Resolved** — ship both the curl script and published images.
- **Documentation** — `sohwe-getting-started.md`: clarified that **Browse files** is Phase 1 / v0.1.0 and Phase 3 is volumes / encrypted env / resource limits only (no duplicate "file browser in Phase 3"). See also `README.md` and `sohwe-prd.md` §10.3 for v0.1.0 UX notes.

## [0.1.0] - 2026-04-22

First milestone: **Phase 0 (foundation)** and **Phase 1 (first deploy)** on a single dev machine, with Docker, Postgres, Redis, and Traefik.

### Added

- **Monorepo** — pnpm workspaces, Turbo, TypeScript, shared `@sohwe/types` and `@sohwe/db` (Prisma).
- **Phase 0** — Fastify API (health, first-run setup, session cookie auth, `/api/me`), Vite + React dashboard, `docker-compose.dev.yml` (Postgres, Redis, Traefik).
- **Phase 1** — `@sohwe/queue` (BullMQ deploy jobs), `@sohwe/builder` (`docker build` with log streaming), `apps/worker` (git clone, build, `dockerode`, Traefik labels, Redis log pub/sub).
- **API** — `POST/GET/DELETE` applications, `POST` deploy and rollback, `GET /api/deployments/:id/logs` (SSE with DB replay + Redis), Docker cleanup on delete.
- **Dashboard** — create app, deploy, build log stream, deploy/rollback in-flight state, 2s polling for application list while a deployment is `pending`/`building`, roll back to a previous successful image, read-only **Browse files** for the running container (list + file preview).
- **Developer UX** — Vite proxy to API for same-origin cookies and `EventSource`; optional `VITE_API_URL` for non-proxied builds.

### Notes

- Phase 1 **deploy path** targets repos with a **Dockerfile** at the repo root. **Nixpacks / no Dockerfile** is planned for Phase 2 (see `sohwe-getting-started.md`).
- PRD “single-command install” and “self-update” for production hosts are **not** part of this release (still on the roadmap for a later version).
