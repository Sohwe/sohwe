# Sohwe Roadmap

Current snapshot: **v0.3.8** plus one unreleased base-domain improvement.

Current phase: **Phase 4 - Observability** is next. Phases 0 through 3.5 are implemented in the repo.

This file is a working checklist. It is based on `README.md`, `CHANGELOG.md`, `sohwe-getting-started.md`, `sohwe-prd.md`, and a code scan across the API, worker, dashboard, Docker, installer, and release workflow.

## Progress Overview

- [x] **Phase 0 - Foundation**
- [x] **Phase 1 - First Deploy**
- [x] **Phase 2 - Broad Runtime Support**
- [x] **Phase 3 - Stateful Apps**
- [x] **Phase 3.5 - Packaging & Install**
- [x] **Unreleased - Configurable apps base domain**
- [ ] **Phase 4 - Observability**
- [ ] **Phase 4.5 - Portable Bundles**
- [ ] **Phase 5 - Git-Push Deploys**
- [ ] **Phase 6 - Multi-User**

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
- [ ] Final fresh-Ubuntu install smoke test after the latest installer/domain changes.
- [ ] Confirm `sohwe update` on a real VPS after the latest installer/domain changes.
- [ ] Confirm rollback after the latest installer/domain changes.

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

## Next Up

### Phase 4 - Observability

Status: **next active phase**

Build log streaming already exists. The missing Phase 4 work is runtime observability for running app containers.

- [ ] Add shared Redis channel helper for runtime logs, likely `logs:app:<id>`.
- [ ] Worker tails `docker logs -f` or dockerode equivalent for managed app containers.
- [ ] Worker publishes runtime log lines to Redis.
- [ ] API exposes authenticated SSE: `GET /api/applications/:id/logs`.
- [ ] API scopes runtime logs by `req.user!.organizationId`.
- [ ] Dashboard adds a `Logs` route/tab under each app.
- [ ] Runtime log view handles reconnects.
- [ ] Add bounded replay or rolling runtime log storage.
- [ ] Keep runtime logs separate from deployment build logs.
- [ ] Last-deploy build logs visible from the app UI.
- [ ] Add live CPU/memory collection from Docker stats.
- [ ] Publish app stats to Redis with a short TTL.
- [ ] API exposes app stats through polling or SSE.
- [ ] Dashboard shows live CPU/memory per app.
- [ ] Worker watches Docker `die`/OOM events for managed containers.
- [ ] Add webhook alert destination model.
- [ ] Add alert destination API routes.
- [ ] Add alert configuration UI.
- [ ] Send Discord/Slack/generic webhook alerts on crash.
- [ ] Ensure alerts never include secrets or sensitive env values.

Current code gaps:

- [ ] No worker runtime log tailer yet.
- [ ] No `logs:app:<id>` channel helper yet.
- [ ] No app runtime logs SSE route yet.
- [ ] No dashboard runtime logs tab yet.
- [ ] No Docker stats endpoint yet.
- [ ] No Docker event crash watcher yet.
- [ ] No alert webhook model/routes/UI yet.

## Future Phases

### Phase 4.5 - Portable Bundles

- [ ] Add `BackupDestination` table.
- [ ] Add `Bundle` table.
- [ ] Add `BackupSchedule` table.
- [ ] Create `packages/bundler`.
- [ ] Implement config-mode signed bundle export.
- [ ] Implement local storage destination.
- [ ] Implement S3-compatible storage destination.
- [ ] Re-encrypt env vars with a passphrase-derived bundle key.
- [ ] Add restore preflight.
- [ ] Add restore apply flow.
- [ ] Add slug collision policies: `rename`, `overwrite`, `skip`.
- [ ] Ensure restored domains do not auto-request certs before DNS confirmation.
- [ ] Add scheduled exports.
- [ ] Add retention policy.
- [ ] Add bundle API routes.
- [ ] Add bundle worker jobs.
- [ ] Add dashboard backup/bundle UI.
- [ ] Add bundle operation logs without secret values.

Current code gaps:

- [ ] No bundle/backup tables in Prisma.
- [ ] No `packages/bundler`.
- [ ] No bundle API routes.
- [ ] No bundle worker jobs.
- [ ] No backup dashboard routes.

### Phase 5 - Git-Push Deploys

- [ ] Add GitHub App configuration.
- [ ] Add GitHub App installation flow.
- [ ] List installation repositories.
- [ ] Clone private repos using installation tokens.
- [ ] Add tracked branch auto-deploy toggle.
- [ ] Add GitHub webhook route.
- [ ] Verify push webhook signatures.
- [ ] Enqueue deploys on tracked branch pushes.
- [ ] Report deploy status back to GitHub.

Current code gaps:

- [ ] No GitHub App models/config.
- [ ] No webhook route.
- [ ] No private repo credential flow.
- [ ] No auto-deploy toggle in schema/dashboard.

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

- [ ] Add runtime log Redis channel helper.
- [ ] Add worker runtime log tailer.
- [ ] Publish runtime lines to Redis.
- [ ] Add `GET /api/applications/:id/logs` SSE.
- [ ] Add dashboard `Logs` route/tab.
- [ ] Add reconnect behavior.
- [ ] Add bounded replay or rolling storage.

### v0.4.1 - Metrics

- [ ] Collect Docker stats for managed containers.
- [ ] Publish CPU/memory/network stats to Redis.
- [ ] Add API endpoint for stats.
- [ ] Show live CPU and memory in dashboard.
- [ ] Handle stopped/no-container states.

### v0.4.2 - Crash Detection And Alerts

- [ ] Watch Docker events for managed container `die`/OOM signals.
- [ ] Add alert destination model.
- [ ] Add webhook destination CRUD.
- [ ] Send Discord/Slack/generic webhook payloads.
- [ ] Add dashboard alert configuration.
- [ ] Scrub secrets from all alert payloads.

### v0.4.3 - Build Log UX Polish

- [ ] Dedicated historical build log route/view.
- [ ] Better failed build summaries.
- [ ] Copy build logs.
- [ ] Download build logs.
- [ ] Clearer queued/building/success/failed states.
- [ ] Log size cap or truncation strategy.

### v0.5.0 - Portable Config Bundles

- [ ] Add bundle/destination/schedule schema.
- [ ] Create `@sohwe/bundler`.
- [ ] Implement local destination first.
- [ ] Implement config export without git mirrors first.
- [ ] Add passphrase re-encryption for env vars.
- [ ] Add restore preflight before mutating restore.

### v0.6.0 - GitHub App And Push Deploys

- [ ] Add GitHub App setup/config.
- [ ] List installation repos.
- [ ] Clone private repos with installation tokens.
- [ ] Verify push webhooks.
- [ ] Add auto-deploy toggle.
- [ ] Report deploy status back to GitHub.

### v0.7.0 - Multi-User And Audit

- [ ] Add invitations.
- [ ] Add role guards.
- [ ] Add user management UI.
- [ ] Add audit log model.
- [ ] Record mutating actions.
- [ ] Keep secret values out of audit entries.

## Highest-Value Immediate Task

Start Phase 4 with runtime logs:

- [ ] Add a worker-side runtime log tailer for managed app containers.
- [ ] Publish lines to Redis on `logs:app:<id>` or a shared helper-defined channel.
- [ ] Add authenticated API SSE at `GET /api/applications/:id/logs`.
- [ ] Add an app `Logs` tab in the dashboard.
- [ ] Verify reconnect behavior.
- [ ] Verify logs do not leak env var values from Sohwe itself.

