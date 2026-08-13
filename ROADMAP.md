# Sohwe Roadmap

Current snapshot: latest tag is **v0.3.8**. Phases 4, 4.5, and 5 are implemented on `main` and staged for release as **v0.6.0** — `CHANGELOG.md` and the root `package.json` are prepared; the tag itself is held until the manual host verification below passes.

Phases 0 through 5 are implemented in the repo. **Phase 4 - Observability** covers runtime logs, live metrics, and crash alerts. **Phase 4.5 - Portable Bundles** is feature-complete: signed config + re-encrypted env var bundles, local + S3-compatible + download destinations, restore preflight/apply, scheduled exports with cron + retention (worker-driven), and the org-level Backups UI. **Phase 5 - Git-Push Deploys** is implemented: per-instance GitHub App via the manifest flow, installation-token clones for private repos, a signature-verified push webhook, the auto-deploy toggle, and commit-status reporting. The build-log UX slice is also done: bounded build-log storage, derived failure summaries, copy/download, and clearer deployment states. All of this ships as **v0.6.0**. Three Phase 3.5 items remain as manual VPS verification (see `docs/vps-smoke-test.md`), and Phase 5 has its own manual end-to-end check; those are the only things holding the tag. **Phase 6 - Multi-User** has since landed on `main` for **v0.7.0**: owner/admin/member role guards on every route, copy-link invitations with hashed single-use tokens, member management, and an org-scoped audit log that records key names and counts but never secret values. Its one optional item — an instance *host* filesystem browser, distinct from the existing container browser — is deferred. **Phase 7 - Managed Datastores** has since landed on `main` for **v0.8.0**: managed Postgres/Redis containers with encrypted generated credentials, private app bindings that inject connection URLs into encrypted env vars, opt-in public host ports, password rotation, and config-only inclusion in portable bundles (bundle format v2).

This file is a working checklist. It is based on `README.md`, `CHANGELOG.md`, `sohwe-getting-started.md`, `sohwe-prd.md`, and a code scan across the API, worker, dashboard, Docker, installer, and release workflow.

## Progress Overview

- [x] **Phase 0 - Foundation**
- [x] **Phase 1 - First Deploy**
- [x] **Phase 2 - Broad Runtime Support**
- [x] **Phase 3 - Stateful Apps**
- [x] **Phase 3.5 - Packaging & Install**
- [x] **Configurable apps base domain**
- [x] **Phase 4 - Observability**
- [x] **Phase 4.5 - Portable Bundles**
- [x] **Phase 5 - Git-Push Deploys**
- [x] **Phase 6 - Multi-User** (optional host file browser deferred)
- [x] **Phase 7 - Managed Datastores**

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

## Staged For v0.6.0

Implemented on `main`, not yet tagged. See *Cutting v0.6.0* at the end of this
file for the release gate.

### Configurable Apps Base Domain

Ships in **v0.6.0**. (Originally sequenced as v0.3.9, which was never tagged —
observability, bundles, and push deploys all landed on top of it.)

- [x] Installer accepts/writes `SOHWE_BASE_DOMAIN`.
- [x] Production compose passes `SOHWE_BASE_DOMAIN` to API.
- [x] Production compose passes `SOHWE_BASE_DOMAIN` to worker.
- [x] API exposes `GET /api/config`.
- [x] Dashboard uses runtime config for generated app URLs.
- [x] Worker uses `SOHWE_BASE_DOMAIN` for Traefik default hosts.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm lint`.
- [x] Run `pnpm build`.
- [ ] Smoke-test dashboard URL display against a real/custom base domain. (manual — needs a host)
- [x] Update docs if the installer prompt text or env behavior changed.
      (`SOHWE_CERT_RESOLVER` threaded through `scripts/install.sh` and
      `docker-compose.prod.yml`; it and `SOHWE_HTTPS_ENABLED` documented in
      `README.md`)

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

- [x] Webhook delivery log. (`WebhookDelivery` model, recorded on every path by
      `apps/api/src/webhook-deliveries.ts`, exposed at `GET /api/github/deliveries`,
      shown in a Recent deliveries panel in `apps/dashboard/src/routes/git.tsx`)
- [ ] GitHub only. GitLab/Gitea would need a separate credential and webhook path.

## Staged For v0.7.0

### Phase 6 - Multi-User

- [x] Add invitation table.
- [x] Add invitation routes.
- [x] Add invitation UI.
- [x] Add role guards beyond simple authentication.
- [x] Add owner/admin/member permission checks.
- [x] Add user management UI.
- [x] Add audit log table.
- [x] Record app create/update/delete events.
- [x] Record deploy/rollback events.
- [x] Record env var key changes without values.
- [x] Record volume changes.
- [x] Record bundle events (export, restore, destinations, schedules).
- [ ] Optional: owner/admin host filesystem browser.
- [ ] Optional: strict host path allowlist.
- [ ] Optional: audit every host file list/read action.

Invitations are copy-link, not email: the API mints a single-use token, returns
the join link once, and stores only its SHA-256. A self-hosted instance
therefore needs no SMTP relay or third-party email key, and a lost link is
revoked and reissued rather than recovered.

Evidence: `packages/db/prisma/schema.prisma` (`Invitation`, `AuditLog`),
`packages/db/prisma/migrations/20260812172122_multi_user_invitations_and_audit_log/`,
`apps/api/src/rbac.ts`, `apps/api/src/audit.ts`, `apps/api/src/routes/members.ts`,
`apps/api/src/routes/audit.ts`, `packages/types/src/index.ts`,
`apps/dashboard/src/lib/roles.ts`, `apps/dashboard/src/routes/members.tsx`,
`apps/dashboard/src/routes/audit.tsx`, `apps/dashboard/src/routes/join.tsx`,
`apps/api/src/rbac.test.ts`, `apps/api/src/audit.test.ts`,
`apps/api/src/routes.test.ts`.

Remaining (optional, deferred): the instance **host** filesystem browser — a
distinct feature from the existing container file browser, and one that needs a
strict root-path allowlist, `..` rejection, and an audit entry per list/read
before it is worth shipping.

## Staged For v0.8.0

### Phase 7 - Managed Datastores

Status: **complete**

An owner/admin creates a Postgres or Redis instance on the same VPS with a few
clicks, then attaches its connection details to one or more apps without SSH,
manual Docker commands, or plaintext credential handling.

- [x] Add `Datastore` table scoped by organization with kind (`postgres` or `redis`), name, slug, status, engine version, resource limits, storage size hint, public port, encrypted credentials, and timestamps. (`packages/db/prisma/schema.prisma`, migration `20260813082152_add_datastores` — purely additive)
- [x] Add `DatastoreBinding` table tracking which apps use a datastore and which env var keys were injected.
- [x] Add shared Docker naming helpers for datastore containers and volumes. (`datastoreContainerName`, `datastoreVolumeName`, `DATASTORE_LABEL` in `packages/types/src/index.ts`; no `sohwe.app` label, which keeps datastores out of the worker's per-app log/stats/crash subsystems)
- [x] Add queue job type for datastore provision/delete/rotate-password operations. (`DATASTORE_QUEUE` + job constants in `packages/queue/src/index.ts`)
- [x] Worker creates a Docker named volume per datastore and starts official `postgres` or `redis` images with Sohwe labels. (`apps/worker/src/datastore-spec.ts` builds the exact container spec, pure and unit-tested; `apps/worker/src/datastores.ts` runs the jobs, pulls images via dockerode, and readiness-polls with `pg_isready` / authenticated `redis-cli ping`)
- [x] Worker attaches datastores to the app's internal Docker network when bound, so apps use private DNS/container names instead of public ports.
- [x] API exposes authenticated CRUD routes for datastores and app bindings, scoped by organization. (`apps/api/src/routes/datastores.ts`, admin-and-above throughout)
- [x] API never returns plaintext datastore passwords except through a deliberate reveal/connection-string endpoint. (`GET /api/datastores/:id/connection`, audited as `datastore.reveal`)
- [x] Dashboard adds a Datastores area with create/list/detail/delete, connection info, password rotate, and app binding flows. (`apps/dashboard/src/routes/datastores.tsx`, `datastore.$datastoreId.tsx`, `apps/dashboard/src/components/datastores/`)
- [x] Binding flow can inject `DATABASE_URL`, `REDIS_URL`, or custom env var keys into the selected app's encrypted env vars. (takes effect on the app's next deploy; rotation rewrites the injected URLs)
- [x] Delete flow requires confirmation and makes clear that deleting the datastore deletes its Docker volume/data.
- [x] Add basic health/status checks by inspecting the container and, later, running `pg_isready` / `redis-cli ping`. (detail endpoint reports live container state; provisioning readiness already uses `pg_isready` / `redis-cli ping`)
- [x] Include managed datastore config in portable bundles; defer raw data backup to full-state bundles. (bundle format v2 — config and bindings by app slug, never credentials; restore generates fresh credentials, rewrites bound env keys, and lands datastores in `idle`)

Open design questions, resolved:

- [x] Public TCP exposure: **opt-in per datastore**, Railway-style. Private Docker networking is the default; a toggle publishes a stable host port (20000-29999) and the connection endpoint returns both an internal and a public URL. The UI warns that public traffic is plain TCP guarded only by the generated password.
- [x] Backups: **config-only in bundles now**; raw data backup waits for full-state bundles.
- [x] Redis persistence: **`appendonly yes` by default** — a managed datastore should not lose data on restart.
- [x] Administration scope: **create/delete/rotate/bind only.** No DB browser, SQL console, dumps, or per-database metrics in this phase.

Remaining manual verification:

- [ ] End-to-end on a real host: create a Postgres datastore, bind it to an app, deploy, and confirm the app reaches it over the internal network; enable public access and connect externally; rotate and confirm bound apps pick up the new URL on redeploy.

Evidence: `packages/db/prisma/schema.prisma`,
`packages/db/prisma/migrations/20260813082152_add_datastores/`,
`packages/types/src/index.ts`, `packages/queue/src/index.ts`,
`apps/worker/src/datastore-spec.ts`, `apps/worker/src/datastores.ts`,
`apps/api/src/routes/datastores.ts`, `apps/api/src/audit.ts`,
`packages/bundler/src/index.ts`, `packages/backups/src/export.ts`,
`apps/api/src/routes/backups.ts`, `apps/dashboard/src/routes/datastores.tsx`,
`apps/dashboard/src/routes/datastore.$datastoreId.tsx`,
`apps/dashboard/src/components/datastores/`,
`apps/worker/src/datastore-spec.test.ts`, `packages/bundler/src/index.test.ts`,
`apps/api/src/routes.test.ts`.

## Release Sequence

The v0.3.9 / v0.4.x / v0.5.0 / v0.6.0 slices below were planned as separate tags
but none were cut — every one of them landed on `main` behind v0.3.8. **They all
ship together as v0.6.0.** The per-slice checklists are kept as a record of what
that tag contains; the release gate itself is under *Cutting v0.6.0* at the end.

### Shipped in v0.6.0

#### Base-Domain Release Polish (was v0.3.9)

- [x] Installer prompt/non-interactive env for `SOHWE_BASE_DOMAIN`.
- [x] Production compose passes the value to API and worker.
- [x] Dashboard app URLs update without rebuilding the dashboard.
- [x] Update docs if install behavior changed.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm lint`.
- [x] Run `pnpm build`.
- [ ] Verify on a real install or staging instance. (manual — needs a host)

#### Runtime Logs (was v0.4.0)

- [x] Add runtime log Redis channel helper.
- [x] Add worker runtime log tailer.
- [x] Publish runtime lines to Redis.
- [x] Add `GET /api/applications/:id/logs` SSE.
- [x] Add dashboard `Logs` route/tab.
- [x] Add reconnect behavior.
- [x] Add bounded replay or rolling storage.

#### Metrics (was v0.4.1)

- [x] Collect Docker stats for managed containers.
- [x] Publish CPU/memory stats to Redis (short TTL).
- [x] Add API endpoint for stats.
- [x] Show live CPU and memory in dashboard.
- [x] Handle stopped/no-container states.

#### Crash Detection And Alerts (was v0.4.2)

- [x] Watch Docker events for managed container `die`/OOM signals.
- [x] Add alert destination model.
- [x] Add webhook destination CRUD.
- [x] Send Discord/Slack/generic webhook payloads.
- [x] Add dashboard alert configuration.
- [x] Scrub secrets from all alert payloads.

#### Build Log UX Polish (was v0.4.3)

- [x] Last-deploy build logs reachable from the app Logs tab.
- [x] Better failed build summaries. (`apps/worker/src/build-failure.ts` derives a
      cause from the log tail into `Deployment.errorMessage`;
      `apps/dashboard/src/components/apps/BuildFailureSummary.tsx` renders it)
- [x] Copy build logs. (`apps/dashboard/src/components/apps/LogPane.tsx`)
- [x] Download build logs. (same component; runtime logs share it)
- [x] Clearer queued/building/success/failed states. (coloured status + spinner in
      `DeploymentsTable.tsx`, trigger badge, `DeploymentStatusLine` in
      `BuildLogViewer.tsx`, `formatDeploymentTiming` in `lib/format.ts`)
- [x] Log size cap or truncation strategy. (`apps/worker/src/build-log.ts`: 512 KiB
      cap, 128 KiB head + 384 KiB tail, in-database append instead of read-modify-write)

#### Portable Config Bundles (was v0.5.0)

- [x] Add bundle/destination/schedule schema.
- [x] Create `@sohwe/bundler`.
- [x] Implement local destination first.
- [x] Implement config export without git mirrors first.
- [x] Add passphrase re-encryption for env vars.
- [x] Add restore preflight before mutating restore.

#### GitHub App And Push Deploys (was the original v0.6.0 slice)

- [x] Add GitHub App setup/config.
- [x] List installation repos.
- [x] Clone private repos with installation tokens.
- [x] Verify push webhooks.
- [x] Add auto-deploy toggle.
- [x] Report deploy status back to GitHub.
- [ ] Verify end-to-end on a real host (push deploy + private clone + commit status). (manual)

### Next: v0.7.0 - Multi-User And Audit

- [x] Add invitations. (copy-link, hashed single-use tokens; no email dependency)
- [x] Add role guards.
- [x] Add user management UI.
- [x] Add audit log model.
- [x] Record mutating actions.
- [x] Keep secret values out of audit entries.
- [ ] Optional: instance host filesystem browser with a path allowlist and per-read auditing.

### Next: v0.8.0 - Managed Postgres And Redis

- [x] One-click Postgres create/delete.
- [x] One-click Redis create/delete.
- [x] Private app-to-datastore networking.
- [x] Encrypted generated credentials.
- [x] App binding that injects connection strings into encrypted env vars.
- [x] Basic datastore health and status display.
- [x] Opt-in public host port per datastore (Railway-style), off by default.
- [x] Datastore config in portable bundles (format v2).
- [ ] Manual end-to-end verification on a real host. (see Phase 7 above)

## Cutting v0.6.0

Phases 4, 4.5, and 5 sit untagged on `main` behind `v0.3.8`, so the published
install is far behind the code. Everything that can be done off-host is done;
what remains needs a real Ubuntu host.

Version number: **v0.6.0**, settled. The release sequence above originally spread
this work over v0.3.9, v0.4.0-v0.4.3, v0.5.0, and v0.6.0; none of those tags were
cut, so v0.6.0 absorbs them all. Minor-version bump, not patch: three phases of
features plus a new required env var (`SOHWE_PUBLIC_URL`).

Ready:

- [x] Adopt a versioned Prisma migration pipeline (was the blocking risk below).
- [x] Run `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`.
- [x] Decide the version number.
- [x] Root `package.json` bumped to `0.6.0`.
- [x] `CHANGELOG.md` `Unreleased` closed into a `[0.6.0]` section.
- [x] Confirm `.github/workflows/release.yml` publishes all three images
      (`api`, `worker`, `dashboard`) multi-arch on a `v*` tag, and moves `latest`
      for stable semver. No hardcoded version pins in `scripts/` or compose —
      `SOHWE_VERSION` defaults to `latest`.

Blocked on a host:

- [ ] Work through `docs/vps-smoke-test.md` to close the three open Phase 3.5 items.
- [ ] Verify Phase 5 end-to-end (push deploy + private clone + commit status).
- [ ] Confirm the `[0.6.0]` date in `CHANGELOG.md` still matches the day of the tag.
- [ ] `git tag v0.6.0 && git push --tags`, then confirm the three images publish.

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

Test coverage:

- [x] Broader test coverage. Every workspace package now has tests — 350 in
      total. `apps/api` (81) includes HTTP-level route tests through
      `app.inject()` against a real schema (auth, sessions, the setup gate,
      organization scoping, secret non-disclosure); `apps/worker` (89) covers the
      build log sink, the failure summarizer, and the full container spec
      (Traefik labels, TLS opt-in, mounts, resource limits). Shared packages
      cover request schemas, Docker naming, queue channel names, backup
      destination resolution, and build-engine selection. The CI `verify` job
      runs them against Postgres and Redis service containers.
- [ ] Remaining untested surface: the worker's imperative Docker calls
      (container create/start/remove, network attach, log tailing, stat
      sampling) and the backup export/restore orchestration. Both need a Docker
      double or a live daemon. Accepted gap — not a tag blocker.
- [ ] Manual VPS smoke test (`docs/vps-smoke-test.md`): prove `sohwe update` and
      the pre-v0.3.8 auto-baseline on a real Ubuntu host. Requires a VPS. **This
      is the tag blocker.**
