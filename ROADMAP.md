# Sohwe Roadmap

Current snapshot: latest tag is **v0.3.8**; Phases 4, 4.5, and 5 are implemented on `main` but untagged.

Phases 0 through 5 are implemented in the repo. **Phase 4 - Observability** covers runtime logs, live metrics, and crash alerts. **Phase 4.5 - Portable Bundles** is feature-complete: signed config + re-encrypted env var bundles, local + S3-compatible + download destinations, restore preflight/apply, scheduled exports with cron + retention (worker-driven), and the org-level Backups UI. **Phase 5 - Git-Push Deploys** is implemented: per-instance GitHub App via the manifest flow, installation-token clones for private repos, a signature-verified push webhook, the auto-deploy toggle, and commit-status reporting. Three Phase 3.5 items remain as manual VPS verification (see `docs/vps-smoke-test.md`), and Phase 5 has its own manual end-to-end check. Next unbuilt milestone is **Phase 6 - Multi-User**.

This file is a working checklist. It is based on `README.md`, `CHANGELOG.md`, `sohwe-getting-started.md`, `sohwe-prd.md`, and a code scan across the API, worker, dashboard, Docker, installer, and release workflow.

## Progress Overview

- [x] **Phase 0 - Foundation**
- [x] **Phase 1 - First Deploy**
- [x] **Phase 2 - Broad Runtime Support**
- [x] **Phase 3 - Stateful Apps**
- [x] **Phase 3.5 - Packaging & Install**
- [x] **Unreleased - Configurable apps base domain**
- [x] **Phase 4 - Observability**
- [x] **Phase 4.5 - Portable Bundles**
- [x] **Phase 5 - Git-Push Deploys**
- [ ] **Phase 6 - Multi-User**
- [ ] **Phase 7 - Managed Datastores** (post-v1/v2)

## Completed

### Phase 0 - Foundation

- [x] pnpm 9 + Turborepo monorepo.
- [x] Shared strict TypeScript config.
- [x] Fastify API app.
- [x] Vite + React dashboard app.
- [x] Worker service.
- [x] Shared packages for DB, types, queue, builder, and crypto.
- [x] Local Postgres, Redis, and Traefik compose setup.
- [x] Prisma schema for organizations, users, sessions, applications, deployments, and volumes.
- [x] First-run setup flow.
- [x] Session-based login and `/api/me`.

Evidence: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `packages/db/prisma/schema.prisma`, `apps/api/src/index.ts`, `apps/dashboard/src/router.tsx`, `docker-compose.dev.yml`.

### Phase 1 - First Deploy

- [x] Create, list, view, and delete applications.
- [x] Manual deploy endpoint.
- [x] BullMQ deploy queue.
- [x] Worker clones Git repos.
- [x] Worker builds Docker images.
- [x] Worker starts Docker containers.
- [x] Worker applies Traefik labels.
- [x] Deployment/application status updates.
- [x] Build logs stream over SSE through Redis pub/sub.
- [x] Persisted `Deployment.buildLogs` replay on reconnect.
- [x] Deployment history UI.
- [x] Current deployment marker.
- [x] Build log viewer.
- [x] Rollback/promote flow.
- [x] Read-only in-container file browser for running apps.
- [x] App delete cleans up Docker containers and DB rows.

Evidence: `apps/api/src/routes/applications.ts`, `apps/api/src/routes/app-filesystem.ts`, `apps/api/src/container-fs.ts`, `apps/worker/src/index.ts`, `packages/queue/src/index.ts`, `apps/dashboard/src/components/apps/DeploymentsPage.tsx`, `apps/dashboard/src/components/apps/BuildLogViewer.tsx`, `apps/dashboard/src/components/apps/FileBrowser.tsx`.

### Phase 2 - Broad Runtime Support

- [x] Build modes: `auto`, `dockerfile`, and `nixpacks`.
- [x] `auto` uses Dockerfile when present.
- [x] `auto` falls back to Nixpacks when no Dockerfile exists.
- [x] Build command override.
- [x] Start command override.
- [x] Editable branch, port, build mode, commands, and custom domain.
- [x] Custom domain support.
- [x] Opt-in HTTPS Traefik labels.
- [x] Commit SHA recorded for deployments.
- [x] Commit subject recorded for deployments.
- [x] Rollback reuses a previous successful image.

Evidence: `packages/builder/src/index.ts`, `packages/types/src/index.ts`, `apps/api/src/routes/applications.ts`, `apps/worker/src/index.ts`, `apps/dashboard/src/components/apps/AppSettingsForm.tsx`, `apps/dashboard/src/components/apps/CreateAppDialog.tsx`, `apps/dashboard/src/components/apps/DeploymentsTable.tsx`.

### Phase 3 - Stateful Apps

- [x] AES-256-GCM encrypted env vars at rest.
- [x] Dedicated env var API routes.
- [x] Masked env var list by default.
- [x] Authenticated reveal support.
- [x] Silent logging on env var mutation routes.
- [x] Worker decrypts env vars only for Docker `Env` injection.
- [x] Persistent volume database model.
- [x] Volume create/list/delete API routes.
- [x] Docker volume naming helper: `sohwe_app_<appId>_<volumeId>`.
- [x] Worker creates and labels named Docker volumes.
- [x] Worker mounts volumes through Docker `Binds`.
- [x] Memory limits saved and applied.
- [x] CPU limits saved and applied.
- [x] Per-app internal Docker network naming helper.
- [x] Worker attaches app containers to Traefik network.
- [x] Worker attaches app containers to per-app internal bridge network.
- [x] App delete removes containers, named volumes, and the per-app network.

Evidence: `packages/crypto/src/index.ts`, `packages/types/src/index.ts`, `apps/api/src/routes/env-vars.ts`, `apps/api/src/routes/volumes.ts`, `apps/api/src/app-public.ts`, `apps/worker/src/index.ts`, `apps/dashboard/src/components/apps/EnvManager.tsx`, `apps/dashboard/src/components/apps/VolumesManager.tsx`, `apps/dashboard/src/components/apps/AppSettingsForm.tsx`.

### Phase 3.5 - Packaging & Install

- [x] Production API Dockerfile.
- [x] Production worker Dockerfile.
- [x] Production dashboard Dockerfile.
- [x] Dashboard nginx config.
- [x] Same-origin `/api` proxy from dashboard image.
- [x] Production compose file.
- [x] HTTPS compose overlay.
- [x] Ubuntu installer script.
- [x] Host-side `sohwe` CLI.
- [x] GHCR multi-arch release workflow for `v*` tags.
- [x] Traefik v3.7 for Docker Engine 29 compatibility.
- [x] HTTP-only install cookie fix using `SOHWE_HTTPS_ENABLED`.
- [ ] Final fresh-Ubuntu install smoke test after the latest installer/domain changes. (manual — see `docs/vps-smoke-test.md`)
- [ ] Confirm `sohwe update` on a real VPS after the latest installer/domain changes. (manual — see `docs/vps-smoke-test.md`)
- [ ] Confirm rollback after the latest installer/domain changes. (manual — see `docs/vps-smoke-test.md`)

Evidence: `docker/api.Dockerfile`, `docker/worker.Dockerfile`, `docker/dashboard.Dockerfile`, `docker/dashboard.nginx.conf`, `docker-compose.prod.yml`, `docker-compose.https.yml`, `scripts/install.sh`, `scripts/sohwe`, `.github/workflows/release.yml`, `CHANGELOG.md`.

## In Progress / Unreleased

### Configurable Apps Base Domain

Suggested release: **v0.3.9**

- [x] Installer accepts/writes `SOHWE_BASE_DOMAIN`.
- [x] Production compose passes `SOHWE_BASE_DOMAIN` to API.
- [x] Production compose passes `SOHWE_BASE_DOMAIN` to worker.
- [x] API exposes `GET /api/config`.
- [x] Dashboard uses runtime config for generated app URLs.
- [x] Worker uses `SOHWE_BASE_DOMAIN` for Traefik default hosts.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm build`.
- [ ] Smoke-test dashboard URL display against a real/custom base domain.
- [ ] Update docs if the installer prompt text or env behavior changed.
- [ ] Tag/release `v0.3.9`.

Evidence: `CHANGELOG.md`, `apps/api/src/index.ts`, `apps/dashboard/src/lib/config.ts`, `apps/worker/src/index.ts`, `docker-compose.prod.yml`, `scripts/install.sh`.

### Phase 4 - Observability

Status: **complete**

Build log streaming already existed from Phase 1; this phase added runtime observability for running app containers.

- [x] Add shared Redis channel helper for runtime logs, likely `logs:app:<id>`.
- [x] Worker tails `docker logs -f` or dockerode equivalent for managed app containers.
- [x] Worker publishes runtime log lines to Redis.
- [x] API exposes authenticated SSE: `GET /api/applications/:id/logs`.
- [x] API scopes runtime logs by `req.user!.organizationId`.
- [x] Dashboard adds a `Logs` route/tab under each app.
- [x] Runtime log view handles reconnects.
- [x] Add bounded replay or rolling runtime log storage.
- [x] Keep runtime logs separate from deployment build logs.
- [x] Last-deploy build logs visible from the app UI.
- [x] Add live CPU/memory collection from Docker stats.
- [x] Publish app stats to Redis with a short TTL.
- [x] API exposes app stats through polling or SSE.
- [x] Dashboard shows live CPU/memory per app.
- [x] Worker watches Docker `die`/OOM events for managed containers.
- [x] Add webhook alert destination model.
- [x] Add alert destination API routes.
- [x] Add alert configuration UI.
- [x] Send Discord/Slack/generic webhook alerts on crash.
- [x] Ensure alerts never include secrets or sensitive env values.

Evidence: `apps/worker/src/index.ts`, `packages/queue/src/index.ts`, `apps/api/src/routes/applications.ts`, `apps/api/src/routes/alert-destinations.ts`, `apps/dashboard/src/routes/app.$appId.logs.tsx`, `apps/dashboard/src/routes/app.$appId.metrics.tsx`.

### Phase 4.5 - Portable Bundles

Feature-complete. The v0.5.0 MVP slice (config + re-encrypted env vars, local +
download, restore preflight/apply, org-level Backups UI) was extended with
S3-compatible destinations, worker-driven scheduled exports, and retention.

- [x] Add `BackupDestination` table.
- [x] Add `Bundle` table. (now links to its `BackupSchedule` for per-schedule retention)
- [x] Add `BackupSchedule` table. (stores an encrypted passphrase + `includeSecrets`; scheduler is live)
- [x] Create `packages/bundler`.
- [x] Implement config-mode signed bundle export.
- [x] Implement local storage destination.
- [x] Implement S3-compatible storage destination. (`@aws-sdk/client-s3`; works with AWS, MinIO, R2, Spaces — credentials encrypted at rest)
- [x] Re-encrypt env vars with a passphrase-derived bundle key.
- [x] Add restore preflight.
- [x] Add restore apply flow.
- [x] Add slug collision policies: `rename`, `overwrite`, `skip`.
- [x] Ensure restored domains do not auto-request certs before DNS confirmation. (restore lands apps in `idle`; nothing deploys until the user does)
- [x] Add scheduled exports. (cron-driven; a 60s worker tick enqueues due schedules)
- [x] Add retention policy. (`retentionCount` keeps the newest N bundles per schedule; prunes the destination file and history row)
- [x] Add bundle API routes. (destinations, export, restore, and schedule CRUD under `/api/backups/*`)
- [x] Add bundle worker jobs. (`backup` queue: a repeatable tick + per-schedule export jobs in `@sohwe/worker`)
- [x] Add dashboard backup/bundle UI. (destinations now support S3; a Scheduled exports panel manages schedules)
- [x] Add bundle operation logs without secret values. (Bundle history records metadata only)

Implementation notes:

- [x] Bundle/backup tables added to Prisma.
- [x] `packages/bundler` added.
- [x] `packages/backups` added — shared destination storage (local + S3) and export/retention orchestration used by both the API (manual export) and the worker (scheduled export).
- [x] Bundle + schedule API routes added (`/api/backups/*`).
- [x] Bundle worker jobs added (`backup` queue, cron tick, retention). Manual export/restore still run synchronously in the API.
- [x] Backup dashboard routes added (`/backups`).

### Phase 5 - Git-Push Deploys

- [x] Add GitHub App configuration. (`packages/github/src/index.ts` manifest builder, `apps/api/src/routes/github.ts`, `GitHubApp` model in `packages/db/prisma/schema.prisma`)
- [x] Add GitHub App installation flow. (`GET /api/github/manifest/new` -> `/manifest/callback` -> `/setup/callback` in `apps/api/src/routes/github.ts`; `apps/dashboard/src/routes/git.tsx`)
- [x] List installation repositories. (`listInstallationRepositories` in `packages/github/src/index.ts`, `GET /api/github/repositories`)
- [x] Clone private repos using installation tokens. (`apps/worker/src/github.ts`, `gitClone` in `apps/worker/src/index.ts`)
- [x] Add tracked branch auto-deploy toggle. (`Application.autoDeploy`, `apps/dashboard/src/components/apps/AutoDeployCard.tsx`, picker in `CreateAppDialog.tsx`)
- [x] Add GitHub webhook route. (`apps/api/src/routes/github-webhook.ts`)
- [x] Verify push webhook signatures. (`verifyWebhookSignature` in `packages/github/src/index.ts`, raw-buffer body parser in the webhook scope)
- [x] Enqueue deploys on tracked branch pushes. (`enqueuePushDeploys` in `apps/api/src/routes/github-webhook.ts`)
- [x] Report deploy status back to GitHub. (`reportCommitStatus` in `apps/worker/src/github.ts`)

Remaining manual verification:

- [ ] End-to-end on a real host: create the app via the manifest flow, install it, push to a tracked branch, and confirm the deploy runs and the commit status appears.
- [ ] Confirm a private repository clones with an installation token.

Known follow-ups (not blockers):

- [ ] No webhook delivery log; debugging a missed push relies on API logs.
- [ ] GitHub only. GitLab/Gitea would need a separate credential and webhook path.

## Not Yet Built

### Phase 6 - Multi-User

The schema already has user roles and organization scoping, but the product is still effectively single-owner.

- [ ] Add invitation table.
- [ ] Add invitation routes.
- [ ] Add invitation UI.
- [ ] Add role guards beyond simple authentication.
- [ ] Add owner/admin/member permission checks.
- [ ] Add user management UI.
- [ ] Add audit log table.
- [ ] Record app create/update/delete events.
- [ ] Record deploy/rollback events.
- [ ] Record env var key changes without values.
- [ ] Record volume changes.
- [ ] Record bundle events once Phase 4.5 exists.
- [ ] Optional: owner/admin host filesystem browser.
- [ ] Optional: strict host path allowlist.
- [ ] Optional: audit every host file list/read action.

Current code gaps:

- [ ] No invitation table/routes/UI.
- [ ] No audit log table/routes.
- [ ] No role guard beyond authenticated organization scoping.
- [ ] No host filesystem browser.

### Phase 7 - Managed Datastores

Status: **post-v1 / v2 candidate**

Goal: let an owner create a Postgres or Redis instance on the same VPS with a few clicks, then attach its connection details to one or more apps without SSH, manual Docker commands, or plaintext credential handling.

MVP scope:

- [ ] Add `Datastore` table scoped by organization with kind (`postgres` or `redis`), name, slug, status, image version, resource limits, storage size hint, encrypted credentials, and timestamps.
- [ ] Add optional `DatastoreBinding` table to track which apps can use a datastore and which env var keys were injected.
- [ ] Add shared Docker naming helpers for datastore containers, volumes, and networks.
- [ ] Add queue job type for datastore provision/delete/rotate-password operations.
- [ ] Worker creates a Docker named volume per datastore and starts official `postgres` or `redis` images with Sohwe labels.
- [ ] Worker attaches datastores to the app's internal Docker network when bound, so apps use private DNS/container names instead of public ports.
- [ ] API exposes authenticated CRUD routes for datastores and app bindings, scoped by organization.
- [ ] API never returns plaintext datastore passwords except through a deliberate reveal/connection-string endpoint.
- [ ] Dashboard adds a Datastores area with create/list/detail/delete, connection info, password rotate, and app binding flows.
- [ ] Binding flow can inject `DATABASE_URL`, `REDIS_URL`, or custom env var keys into the selected app's encrypted env vars.
- [ ] Delete flow requires confirmation and makes clear that deleting the datastore deletes its Docker volume/data.
- [ ] Add basic health/status checks by inspecting the container and, later, running `pg_isready` / `redis-cli ping`.
- [ ] Include managed datastore config in portable bundles; defer raw data backup to full-state bundles.

Open design questions:

- [ ] Should the first version expose datastores only to bound apps on private Docker networks, or also offer optional public TCP exposure?
- [ ] Should backups be part of the first managed-datastore release, or arrive with full-state bundles?
- [ ] Should Redis default to persistence enabled (`appendonly yes`) or ephemeral cache mode with an explicit persistence toggle?
- [ ] How much database administration belongs in Sohwe v2: create DB/user only, or browser, SQL console, dumps, restores, and metrics?

## Recommended Release Sequence

### v0.3.9 - Base-Domain Release Polish

- [ ] Verify installer prompt/non-interactive env for `SOHWE_BASE_DOMAIN`.
- [ ] Verify production compose passes the value to API and worker.
- [ ] Verify dashboard app URLs update without rebuilding the dashboard.
- [ ] Update docs if install behavior changed.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm build`.
- [ ] Smoke test a fresh install or staging instance.
- [ ] Tag `v0.3.9`.

### v0.4.0 - Runtime Logs

- [x] Add runtime log Redis channel helper.
- [x] Add worker runtime log tailer.
- [x] Publish runtime lines to Redis.
- [x] Add `GET /api/applications/:id/logs` SSE.
- [x] Add dashboard `Logs` route/tab.
- [x] Add reconnect behavior.
- [x] Add bounded replay or rolling storage.

### v0.4.1 - Metrics

- [x] Collect Docker stats for managed containers.
- [x] Publish CPU/memory stats to Redis (short TTL).
- [x] Add API endpoint for stats.
- [x] Show live CPU and memory in dashboard.
- [x] Handle stopped/no-container states.

### v0.4.2 - Crash Detection And Alerts

- [x] Watch Docker events for managed container `die`/OOM signals.
- [x] Add alert destination model.
- [x] Add webhook destination CRUD.
- [x] Send Discord/Slack/generic webhook payloads.
- [x] Add dashboard alert configuration.
- [x] Scrub secrets from all alert payloads.

### v0.4.3 - Build Log UX Polish

- [x] Last-deploy build logs reachable from the app Logs tab.
- [ ] Better failed build summaries.
- [ ] Copy build logs.
- [ ] Download build logs.
- [ ] Clearer queued/building/success/failed states.
- [ ] Log size cap or truncation strategy.

### v0.5.0 - Portable Config Bundles

- [x] Add bundle/destination/schedule schema.
- [x] Create `@sohwe/bundler`.
- [x] Implement local destination first.
- [x] Implement config export without git mirrors first.
- [x] Add passphrase re-encryption for env vars.
- [x] Add restore preflight before mutating restore.

### v0.6.0 - GitHub App And Push Deploys

- [x] Add GitHub App setup/config.
- [x] List installation repos.
- [x] Clone private repos with installation tokens.
- [x] Verify push webhooks.
- [x] Add auto-deploy toggle.
- [x] Report deploy status back to GitHub.
- [ ] Verify end-to-end on a real host (push deploy + private clone + commit status).

### v0.7.0 - Multi-User And Audit

- [ ] Add invitations.
- [ ] Add role guards.
- [ ] Add user management UI.
- [ ] Add audit log model.
- [ ] Record mutating actions.
- [ ] Keep secret values out of audit entries.

### v0.8.0 / v2 Candidate - Managed Postgres And Redis

- [ ] One-click Postgres create/delete.
- [ ] One-click Redis create/delete.
- [ ] Private app-to-datastore networking.
- [ ] Encrypted generated credentials.
- [ ] App binding that injects connection strings into encrypted env vars.
- [ ] Basic datastore health and status display.

## Highest-Value Immediate Task

Cut a release. A large amount of shipped work (Phases 4 and 4.5) sits untagged on
`main` behind `v0.3.8`, so the published install is far behind the code.

- [x] Adopt a versioned Prisma migration pipeline (was the blocking risk below).
- [x] Run `pnpm typecheck`, `pnpm lint`, `pnpm build`.
- [ ] Work through `docs/vps-smoke-test.md` to close the three open Phase 3.5 items.
- [ ] Decide the version number (the release sequence above implies the base-domain
      change is v0.3.9, but observability + bundles have since landed on top of it).
- [ ] Tag, and confirm `.github/workflows/release.yml` publishes all three images.

### Migration pipeline — done

`sohwe migrate` now runs `prisma migrate deploy` against versioned SQL in
`packages/db/prisma/migrations`, replacing `prisma db push --accept-data-loss`.
Databases from v0.3.8 and earlier are baselined automatically on first run
(history row only, no DDL). The Phase 4/4.5 migration is purely additive, so it
carries onto existing installs without touching existing rows.

Verified against a disposable Postgres 16: fresh-install deploy applies both
migrations with zero drift; a seeded v0.3.8-shaped database baselines, applies
only the additive migration, keeps its rows, and reports zero drift.

Evidence: `packages/db/prisma/migrations/`, `scripts/sohwe` (`cmd_migrate`),
`package.json`, `CHANGELOG.md`.

### Remaining pre-release risks

- [x] CI runs `typecheck` / `lint` / `build` on every push and PR, plus a
      migrations job (fresh-install + pre-v0.3.8 upgrade, drift + data-loss
      guards) and a shellcheck/LF job for the scripts (`.github/workflows/ci.yml`).
- [x] Rate limiting on `POST /api/auth/login` and `POST /api/setup/unlock`
      (10/min/IP via `@fastify/rate-limit`, `trustProxy` for real client IPs).
- [x] Boot-time env validation in the API and worker (fail fast on missing
      `SESSION_SECRET`, short secret, or bad `SOHWE_ENCRYPTION_KEY`).
- [x] Setup-gate cookie enforces its signed `t` timestamp against a 7-day
      lifetime; stale/future/timestamp-less cookies are rejected.
- [x] CORS origin is configurable (`SOHWE_CORS_ORIGIN`) and defaults to disabled
      in production instead of a hardcoded dev origin.
- [x] Expired sessions are swept on boot and hourly.

Security batch verified by running: env validation (fail + boot), 429 after the
10th auth request, forged/stale gate cookies rejected while valid ones pass,
CORS off in prod and scoped in dev, and the boot sweep deleting only the expired
session. Evidence: `apps/api/src/env.ts`, `apps/api/src/session.ts`,
`apps/api/src/setup-gate.ts`, `apps/api/src/index.ts`, `apps/worker/src/index.ts`.

- [x] Unit tests for `packages/crypto` (32) and `packages/bundler` (17),
      including a frozen golden bundle that pins the cross-instance format.
      Run by `pnpm test` (Node's runner via `tsx`) and enforced in the CI
      `verify` job. Evidence: `packages/crypto/src/index.test.ts`,
      `packages/bundler/src/index.test.ts`, `.github/workflows/ci.yml`.

Still open before a tag:

- [ ] Broader test coverage. The API/worker route and deploy logic, and the
      remaining `packages/*`, still have no tests; the crypto/bundle contract is
      covered but the HTTP and Docker-orchestration paths are not.
- [ ] Manual VPS smoke test (`docs/vps-smoke-test.md`): prove `sohwe update` and
      the pre-v0.3.8 auto-baseline on a real Ubuntu host. Requires a VPS.
