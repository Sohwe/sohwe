# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries for v0.3.8 and earlier are summarized; see the git history for the full
write-ups.

## [Unreleased]

### Security

- **Rate limiting on the unauthenticated credential endpoints.** `POST /api/auth/login` and `POST /api/setup/unlock` are now limited to 10 requests per minute per client IP (`@fastify/rate-limit`), returning `429` with `Retry-After` past the threshold. The API runs with `trustProxy` so the limit keys off the real client IP forwarded by Traefik/nginx rather than the proxy's address. Other routes — including the dashboard's frequent metrics polling and long-lived log SSE — are unaffected.
- **Fail-fast environment validation at boot.** The API and worker now validate their environment before opening any socket or connection and exit with a clear, aggregated message if it is wrong. This closes a silent-failure mode where an unset `SESSION_SECRET` left the setup-gate cookie unsigned (so unlock returned `{ok:true}` but never actually unlocked), and surfaces a missing or wrong-length `SOHWE_ENCRYPTION_KEY` at startup instead of mid-deploy when the worker first decrypts env vars.
- **Setup-gate cookie now expires server-side.** The gate cookie signs an issue timestamp; verification now enforces it against a 7-day lifetime (matching the cookie's `Max-Age`), rejecting stale, future-dated, or timestamp-less cookies. Previously the timestamp was signed but never checked, so a leaked gate cookie was valid indefinitely.
- **Configurable CORS; no dev origin shipped to production.** The API's allowed CORS origin is read from the optional `SOHWE_CORS_ORIGIN` (comma-separated list, or `*`). When unset it defaults to disabled under `NODE_ENV=production` (the dashboard is same-origin through nginx) and to `http://localhost:3000` otherwise. Previously `http://localhost:3000` was hardcoded into the production image.
- **Expired sessions are swept.** The API deletes expired session rows on boot and hourly thereafter, so the table no longer accumulates 30-day-lived rows indefinitely. Expiry was already enforced at read time; this reclaims the storage.

### Tests

- **First unit tests, on the crypto and bundle-format code.** `@sohwe/crypto` (32 tests: encrypt/decrypt round-trips, GCM tamper/wrong-key rejection, `decryptJson` validation, scrypt key derivation, HMAC verification) and `@sohwe/bundler` (17 tests: canonicalization, build/parse round-trips, wrong-passphrase and tamper rejection) now have tests using Node's built-in runner via `tsx`, run by `pnpm test` and wired into the CI `verify` job. The bundler suite includes a **frozen golden bundle** produced by a real export, which must keep parsing forever — it fails loudly if the on-disk bundle format changes incompatibly, protecting cross-instance restore.

### Changed

- **Versioned database migrations replace `db push --accept-data-loss`.** `sohwe migrate` — which `sohwe update` and the installer both call — now runs `prisma migrate deploy`, replaying reviewed SQL from the new `packages/db/prisma/migrations` directory instead of force-pushing the schema. Previously any upgrade that narrowed or removed a column would drop that column's data without prompting.

  Two migrations are committed: `20260722000000_init` reproduces the schema shipped by every published tag through v0.3.8, and `20260722000100_observability_and_backups` adds the Phase 4 + 4.5 tables (`alert_destinations`, `backup_destinations`, `bundles`, `backup_schedules`). The second is **purely additive** — four `CREATE TABLE`s plus indexes and foreign keys, with no `ALTER` against existing tables — so upgrading an existing install does not touch existing rows.

  **Upgrading from v0.3.8 or earlier requires no manual step.** Those databases were created by `db push` and have no `_prisma_migrations` table, so `prisma migrate deploy` refuses with `P3005`. `sohwe migrate` detects that specific error and baselines the database by marking `init` as already-applied — a history row only, no DDL — then applies the remaining migrations. Because every tag through v0.3.8 shipped a byte-identical schema, this state is unambiguous. Any other migration failure is surfaced and does not trigger a baseline.

  Migrations are forward-only. `sohwe rollback` restores the previous images but does not revert schema changes; additive migrations leave the older version working, and any future destructive migration will be called out here.

- **Migrations now run automatically as a one-shot `migrate` service.** `docker-compose.prod.yml` gained a `migrate` service that runs `prisma migrate deploy` — auto-baselining a pre-v0.3.8 database when it sees `P3005` — and then exits. `api` and `worker` depend on it with `condition: service_completed_successfully`, so every `docker compose up -d` brings the schema forward before any application code connects, and a failed migration blocks startup instead of leaving the API running against a stale schema. The logic lives in `packages/db/bin/migrate-deploy.mjs` (also runnable with `--status`), which ships inside the API image; the CI `migrations` job now exercises that exact script on both the fresh-install and the pre-v0.3.8 upgrade path rather than re-implementing its steps. `sohwe migrate` is unchanged and still works.

- New `sohwe migrate-status` subcommand shows applied vs pending migrations.
- New root scripts: `pnpm db:migrate`, `pnpm db:migrate:deploy`, `pnpm db:migrate:status`. `pnpm db:push` remains for throwaway scratch databases but must not be used for committed schema changes.

### Added

- **Phase 4.5 portable config bundles.** A new org-level **Backups** area exports every app's configuration as a single signed, passphrase-protected `.sohwe.json` document and restores it on the same or a different Sohwe instance. Bundles are config-only — app settings, volume *definitions* (mount paths, not data), alert destinations, and optionally re-encrypted env vars; no git mirrors and no volume data. `@sohwe/bundler` derives a 32-byte key from the passphrase via scrypt (salt stored in the bundle), AES-256-GCM-encrypts each app's env vars, and HMAC-SHA256-signs the manifest so a wrong passphrase or any tampering is rejected at restore. Org-scoped routes live under `/api/backups`: destination CRUD (`/destinations`), bundle history (`GET /api/backups`), `POST /api/backups/export`, `POST /api/backups/restore/{preflight,apply}`, and schedule CRUD (`/schedules`). Restore is non-destructive by default: apps land in `idle` (nothing deploys, no Traefik routers, no ACME cert requests until the user deploys), and slug collisions are resolved by an explicit `rename` / `overwrite` / `skip` policy chosen after a preflight summary (which reports env var *key counts*, never values). New Prisma models: `BackupDestination`, `Bundle`, `BackupSchedule`.
- **Backup destinations and scheduling.** `@sohwe/backups` implements local-filesystem and S3-compatible destinations (`@aws-sdk/client-s3`; works with AWS, MinIO, R2, Spaces) with credentials encrypted at rest. Scheduled exports run on a `backup` BullMQ queue owned by the worker: a 60s repeatable tick enqueues due cron schedules, and `retentionCount` keeps the newest N bundles per schedule, pruning both the destination file and the history row. Manual export and restore still run synchronously in the API.
- **Phase 4 runtime logs.** The worker attaches to managed app containers with Docker log streaming, publishes stdout/stderr lines to Redis on per-app channels, and re-attaches to already-running managed containers on startup. The API exposes authenticated, organization-scoped runtime log SSE at `GET /api/applications/:id/logs`, including a short replay from the container's recent Docker logs. The dashboard adds a per-app **Logs** tab, separate from deployment build logs.
- **Phase 4 live metrics.** The worker samples one-shot Docker stats for running managed containers every ~3s and writes `{cpuPercent, memUsedBytes, memLimitBytes, memPercent}` to Redis under `stats:app:<id>` with a 10s TTL. `GET /api/applications/:id/stats` is an organization-scoped polling read returning `{ running: false }` when no fresh sample exists. The dashboard adds a per-app **Metrics** tab (polled every 3s).
- **Phase 4 crash alerts.** The worker watches Docker `die`/`oom` events for managed containers; on a non-zero-exit crash or OOM kill it marks the app `crashed` and POSTs a webhook to each enabled per-app destination. A new `AlertDestination` model (per-app, `slack`/`discord`/`generic`) is managed via CRUD under `/api/applications/:id/alert-destinations` and a **Crash alerts** section on app Settings. Payloads carry only app name/slug, event, exit code, container id, and timestamp — never env var values or other secrets.
- **Last-deploy build logs in the app UI.** The **Logs** tab gains a Runtime / Last build toggle; "Last build" replays the most recent deployment's build logs via the existing `GET /api/deployments/:id/logs` SSE.

### Changed

- **Configurable apps base domain.** `SOHWE_BASE_DOMAIN` is now an installer prompt (defaults to the dashboard host, falling back to `sohwe.localhost`) written to `/etc/sohwe/sohwe.env` and plumbed into both api and worker via `docker-compose.prod.yml`'s shared env block — the worker always read it for Traefik labels, but it was never *set* anywhere except hardcoded defaults. The api serves it back over `GET /api/config` (public, no-auth, allowed through the setup gate). The dashboard's hardcoded `lib/constants.ts#baseDomain` is replaced by `lib/config.ts#useBaseDomain`, a TanStack Query hook with `staleTime: Infinity`. An operator can now point a real wildcard domain at the box (`*.apps.example.com A <ip>`) and get correct URLs without rebuilding any image.

## [0.3.8] - 2026-05-09

### Fixed

- **Traefik on Docker 29 hosts** — bumped `traefik:v3.1` → `traefik:v3.7`. Traefik ≤v3.6 pinned Docker SDK version 1.24; Docker Engine 29 requires ≥1.40, so the docker provider errored, registered no routers, and every request 404'd. v3.7 negotiates via `client.FromEnv`.
- **HTTP-only installs couldn't get past the unlock screen** — setup-gate and session cookies used `secure: NODE_ENV === "production"`, which browsers refuse to store over plain HTTP. Both now derive `Secure` from `SOHWE_HTTPS_ENABLED`.
- **Installer (v0.3.5–v0.3.8 line)** — `curl | bash` no longer dies re-execing under `sudo` (piped runs re-download to a temp file, since `$0` is the interpreter); `/etc/sohwe/` is created up front in `fetch_assets`.
- **`sohwe` CLI** — `up` and `restart` now run `docker compose up -d` (then bounce Traefik) so pending `sohwe.env` / overlay edits actually apply; plain `restart` silently ignored them.

### Added

- **Phase 3.5 — Packaging & Install.** One-command install on fresh Ubuntu 22.04/24.04.
  - Multi-stage production Dockerfiles on `node:24-slim` (`api` via `tsx`; `worker` baking in `git`, `docker-ce-cli`, pinned `nixpacks`; `dashboard` built by Vite, served by `nginx:alpine`).
  - `docker/dashboard.nginx.conf` — same-origin static + SPA fallback with `/api` and `/health` proxied to the api service (no CORS, first-party cookies, SSE-friendly).
  - `docker-compose.prod.yml` — api + worker + dashboard + postgres + redis + traefik across `sohwe_proxy` (public) and `sohwe_internal` (control plane); Traefik dashboard off, Docker socket read-only, Let's Encrypt HTTP-01 pre-wired. `docker-compose.https.yml` overlays TLS + HTTP→HTTPS redirect when a domain is given.
  - `scripts/install.sh` — idempotent; installs Docker, prompts via `/dev/tty`, generates `/etc/sohwe/sohwe.env` (random `SESSION_SECRET`, `SOHWE_ENCRYPTION_KEY`, Postgres password, mode 0600), applies the schema, prints the dashboard URL.
  - `sohwe` CLI at `/usr/local/bin/sohwe` — `up`, `down`, `restart`, `status`, `logs`, `pull`, `migrate`, `update [version]`, `rollback`, `version`, `env`. `update` stashes the previous version so `rollback` works for one hop; rollback intentionally does not reverse schema changes.
  - `.github/workflows/release.yml` — multi-arch (`amd64` + `arm64`) GHCR publish on `v*` tags; `latest` moves only for stable semver. Plus a root `.dockerignore`.

### Changed

- **Dashboard** — complete UI revamp: Render-style shell (collapsible sidebar, top bar, breadcrumbs), TanStack Router URL routes, shadcn-style Radix primitives, light/dark theme, sonner notifications, deploy log in a slide-over sheet, env editor with bulk `.env` paste, confirm dialogs replacing `window.confirm`.

## [0.3.0] - 2026-04-23

**Phase 3 (stateful apps)** — encrypted env vars, persistent named volumes, per-app memory/CPU limits, and a per-app isolated internal Docker network.

- `@sohwe/crypto` — AES-256-GCM helpers shared by API and worker.
- API — `GET/PUT/PATCH /api/applications/:id/env` (masked by default, `?reveal=true` for plaintext, silent logging on mutations); volume CRUD under `/api/applications/:id/volumes`; `memoryLimitMb` and `cpuLimit` on `PATCH /api/applications/:id`. Responses use an explicit `select` so `envVarsEncrypted` is never returned, and `sizeBytes` is JSON-safe.
- Worker — decrypts env into `Env:`, pre-creates and labels named volumes (`sohwe_app_<appId>_<volumeId>`) as `Binds`, applies `HostConfig.Memory` / `NanoCpus`, and connects each container to `sohwe_app_<appId>_net`. Delete removes containers, volumes, and the network before the DB row.
- Dashboard — env panel, volumes panel, memory/CPU fields in settings.

**Note:** `SOHWE_ENCRYPTION_KEY` must be set for the **worker** as well as the API (same value) or deploys cannot decrypt env.

## [0.2.0] - 2026-04-23

**Phase 2 (broad runtime support)** — Nixpacks auto-detection, build/start command overrides, editable settings, custom domains with opt-in HTTPS.

- `@sohwe/builder` dispatches between `docker build` and `nixpacks build` via `buildAppImage({ mode, ... })`; `auto` prefers a Dockerfile, otherwise Nixpacks detects Next.js / Node / Python / Go / Rust / static.
- API — `CreateApplicationSchema` persists the real `buildMode`; new `PATCH /api/applications/:id` for partial updates.
- Custom domains + HTTPS — worker emits a `websecure` router and HTTP→HTTPS redirect when `SOHWE_HTTPS_ENABLED=true` and the app has a public domain; `.localhost` / `.local` stay HTTP-only. Cert resolver configurable via `SOHWE_CERT_RESOLVER`.
- Traefik dev compose gains a `websecure` entrypoint, a named `traefik_acme` volume, and an opt-in Let's Encrypt resolver.
- Deployments table per app — short id, **Current** marker, status/duration, branch, commit SHA + subject, log link, per-row rollback. Adds `Deployment.commitMessage`.

## [0.1.0] - 2026-04-22

**Phase 0 (foundation) + Phase 1 (first deploy)** on a single dev machine.

- Monorepo — pnpm workspaces, Turbo, TypeScript, shared `@sohwe/types` and `@sohwe/db`.
- API — health, first-run setup, session cookie auth, `/api/me`; application CRUD, deploy and rollback, `GET /api/deployments/:id/logs` (SSE with DB replay + Redis), Docker cleanup on delete.
- Worker — `@sohwe/queue` (BullMQ deploy jobs), `@sohwe/builder` (`docker build` with log streaming), git clone, dockerode, Traefik labels, Redis log pub/sub.
- Dashboard — create app, deploy, live build log, rollback, read-only container file browser.

**Note:** the Phase 1 deploy path required a root `Dockerfile`; Nixpacks arrived in v0.2.0.
