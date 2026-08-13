# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries for v0.3.8 and earlier are summarized; see the git history for the full
write-ups.

## [Unreleased]

### Added

- **Host file browser** (the deferred Phase 6 optional item). A new **Host files** page lets admins and owners browse and read files on the instance host, read-only. It is off by default and gated by an explicit allowlist: `SOHWE_HOST_FS_ALLOWLIST` names the absolute paths the API may serve (comma-separated), a typo'd entry refuses to boot, and every path is realpath-resolved and re-checked against the allowlisted roots so a symlink inside a root cannot escape it. Every directory listing and file read is recorded in the audit log (`host_fs.list` / `host_fs.read`, with the path as the target label); denied attempts do not reveal whether a symlink's target exists. In production the API container sees only what compose mounts in — `docker-compose.prod.yml` now mounts `/etc/sohwe` read-only, so allowlisting `/etc/sohwe` works out of the box, and other paths need their own read-only mounts. Routes: `GET /api/host-fs`, `/api/host-fs/list`, `/api/host-fs/file` (admin-and-above).

- **Phase 7 managed datastores.** An admin can create a Postgres 16/17 or Redis 7 instance on the host from the new **Datastores** page — a Sohwe-owned container using the official image, a persistent named volume, generated credentials encrypted at rest, and Sohwe labels. No SSH, no manual Docker, no plaintext credential handling. The worker provisions asynchronously over a new `datastore` queue (image pull, volume + container create, readiness poll via `pg_isready` / authenticated `redis-cli ping`), and Redis runs with `appendonly yes` so its data survives restarts. Routes live under `/api/datastores` (admin-and-above throughout), with audit events for create, provision, delete, password rotation, connection reveal, bind, and unbind.

- **Datastore bindings.** Binding a datastore to an app injects its connection URL (`DATABASE_URL` / `REDIS_URL`, or a custom key) into the app's encrypted env vars and attaches the datastore container to the app's internal Docker network, so the app reaches it by container DNS name — private, never through public ports. Changes take effect on the app's next deploy. Unbinding removes exactly the recorded keys. Password rotation (in-place `ALTER USER` for Postgres over the container's local socket; container recreation for Redis) rewrites every bound app's injected URL, so a redeploy picks up the new credentials.

- **Opt-in public datastore access.** Railway-style: datastores are private by default, and a per-datastore toggle publishes the service on a stable host port (20000–29999, unique per instance). Connection info then shows both the internal URL and a public URL built from `SOHWE_BASE_DOMAIN`. The UI warns that the traffic is plain TCP with the generated password as the only protection. Disabling the toggle closes the port; both directions recreate the container (data survives on its volume).

- **Datastore config in portable bundles.** Bundles now carry each datastore's config — kind, name, slug, engine version, resource limits, public port, and app bindings by slug — never credentials or data. Restore applies the usual `rename` / `overwrite` / `skip` collision policy, generates fresh credentials, rewrites bound apps' injected env keys to match, and lands every restored datastore in `idle` so nothing provisions until the user acts. `overwrite` deliberately narrows for datastores: only the name and resource limits are updated, never the engine version or credentials of a live instance.

- **Phase 6 roles and permission checks.** The three roles the schema always carried are now enforced. `owner` has full control including role management; `admin` covers everything operational (apps, env vars, volumes, backups, Git, invitations, removing members) but cannot touch owners; `member` is read-only plus deploying and rolling back existing apps. A `requireRole(min)` preHandler (`apps/api/src/rbac.ts`) replaces bare authentication on every route, authenticating first so a route can never end up role-checked but unauthenticated. Unknown role strings rank below `member` and get nothing, so a downgrade or a hand-edited row fails closed. The sidebar, app tabs, and the "New app" button hide what the caller cannot use, but the API is the enforcement point.

  Surfaces that can expose an app's secrets are admin-and-above **including reads**: env vars (even the masked listing — `maskedPreview` still shows part of every value), the container file browser (it reaches config files and `/proc/self/environ`), alert destinations (a Discord/Slack webhook URL is a bearer credential), backups (bundles carry re-encrypted env vars), and the GitHub connection. Existing single-owner installs are unaffected — the owner keeps every permission.

- **Phase 6 invitations.** An admin creates a single-use join link from the new **Members** page; Sohwe does not send email, so the link is copied and delivered by hand. That keeps self-hosted instances free of an SMTP relay or a third-party email API key. Only the SHA-256 of the token is stored, so the raw link is shown exactly once, in the create response — a lost link is revoked and reissued, not recovered. Links expire after 7 days, grant `admin` or `member` (never `owner`), and are consumed inside a transaction that claims the row conditionally, so two people opening the same link cannot both get an account. Accepting creates the account and signs the new member straight in. Routes: `GET/POST /api/invitations`, `DELETE /api/invitations/:id`, plus rate-limited pre-auth `GET /api/invitations/lookup` and `POST /api/invitations/accept`. New `Invitation` model, new dashboard route `/join?token=…`.

- **Phase 6 member management.** `GET /api/members` lists the organization (any member may see who else is in it), `PATCH /api/members/:id/role` is owner-only, and `DELETE /api/members/:id` is admin-and-above. The organization can never be left without an owner, nobody can change their own role or remove their own account, and an admin cannot remove an owner. Removing a member cascades their sessions, so they are signed out everywhere immediately. Role changes take effect on the target's next request without re-login.

- **Phase 6 audit log.** A new append-only `AuditLog` model records who did what, org-scoped, readable at `GET /api/audit-logs` (admin-and-above, filterable by action/target/actor with cursor pagination) and on a new **Audit log** page. Covered: application create/update/delete, deploy, rollback, env var updates and reveals, volume create/delete, alert destination changes, backup export/restore, backup destination and schedule changes, GitHub connect/disconnect, and every membership event (invite, revoke, join, role change, removal). **No secret material is recorded**: env events carry key *names*, counts, and which keys were added/removed/changed, never values; backup events carry app counts and destination kinds, never passphrases or S3 credentials; GitHub events carry the public App identity, never the PEM or webhook secret; invitation events never carry the token. The actor's email is denormalized onto the row, so removing a user leaves their trail readable instead of erasing it. Recording is best-effort and can never fail the action it describes.

### Changed

- **Bundle format bumped to v2** for the datastore section. This build reads v1 and v2 bundles; older Sohwe versions cannot read v2 bundles (they fail cleanly with "Unrecognized or unsupported bundle format"). The frozen v1 golden bundle still parses, and a v2 golden now pins the new format.

- Deleting an app now disconnects any bound datastore containers from the app's internal network before removing it. Previously a lingering endpoint made Docker refuse the network removal and failed the whole app delete.

- New `datastores` and `datastore_bindings` tables via a purely additive migration (`20260813082152_add_datastores`). No existing rows are touched.

- The API's deploy queue and stats Redis client are now created per server instance and opened lazily on first use, instead of at module load. Previously one `app.close()` closed connections shared by every server built in the same process, which only mattered to the route tests — they build a fresh server per test, and every deploy after the first failed with `Connection is closed`.

- `AUTH_RATE_LIMIT` moved to `apps/api/src/rate-limit.ts` and the request-origin helper to `apps/api/src/public-url.ts`, both now shared with the invitation routes. Login and setup unlock behave as before; the pre-auth invitation lookup and accept endpoints carry the same limit.

## [0.6.0] - 2026-08-12

The first release since v0.3.8, covering everything that accumulated on `main`
behind it: Phase 4 (observability), Phase 4.5 (portable bundles), Phase 5
(git-push deploys), a versioned migration pipeline, a security batch, and test
coverage across every workspace package. The intermediate versions sketched in
`ROADMAP.md` — v0.3.9 (base domain), v0.4.0–v0.4.3 (logs, metrics, alerts,
build-log UX), and v0.5.0 (bundles) — were never tagged; this release contains
all of them.

Upgrading from v0.3.8 or earlier needs no manual step. See **Versioned database
migrations** under Changed for what happens to the schema.

### Added

- **Phase 4 runtime logs.** The worker attaches to managed app containers with Docker log streaming, publishes stdout/stderr lines to Redis on per-app channels, and re-attaches to already-running managed containers on startup. The API exposes authenticated, organization-scoped runtime log SSE at `GET /api/applications/:id/logs`, including a short replay from the container's recent Docker logs. The dashboard adds a per-app **Logs** tab, separate from deployment build logs.

- **Phase 4 live metrics.** The worker samples one-shot Docker stats for running managed containers every ~3s and writes `{cpuPercent, memUsedBytes, memLimitBytes, memPercent}` to Redis under `stats:app:<id>` with a 10s TTL. `GET /api/applications/:id/stats` is an organization-scoped polling read returning `{ running: false }` when no fresh sample exists. The dashboard adds a per-app **Metrics** tab (polled every 3s).

- **Phase 4 crash alerts.** The worker watches Docker `die`/`oom` events for managed containers; on a non-zero-exit crash or OOM kill it marks the app `crashed` and POSTs a webhook to each enabled per-app destination. A new `AlertDestination` model (per-app, `slack`/`discord`/`generic`) is managed via CRUD under `/api/applications/:id/alert-destinations` and a **Crash alerts** section on app Settings. Payloads carry only app name/slug, event, exit code, container id, and timestamp — never env var values or other secrets.

- **Last-deploy build logs in the app UI.** The **Logs** tab gains a Runtime / Last build toggle; "Last build" replays the most recent deployment's build logs via the existing `GET /api/deployments/:id/logs` SSE.

- **Build log UX.** The build log viewer gained copy and download buttons, and now follows the tail only while the reader is already at the bottom — an arriving line no longer yanks the view down mid-read, and a **Follow** button jumps back. The runtime log viewer shares the same component and gained the same controls. Deployment status is now colour-coded in the deployments table on desktop (it was rendered in the default text colour, so a failed deploy looked identical to a successful one), with a spinner while queued or building and a badge naming what triggered the deploy.

- **Failed builds now say what failed.** `Deployment.errorMessage` used to hold whatever the build tool threw, which is almost always `docker build failed with exit code 1` — identical for every failure and useless without reading the whole log. The worker now scans the tail of the build output for known signatures and stores a short diagnosis instead: a headline naming the cause, the log lines that justify it, an actionable hint where one applies, and the raw error last. Recognized causes include host disk exhaustion, Node heap exhaustion, OOM kills, inaccessible or non-existent base images, npm/pnpm/pip/TypeScript failures, and the failing Dockerfile step with its exit code. The dashboard renders it above the log on both the Logs tab and the deployment sheet. Log lines are redacted for installation tokens on the same path the error message already was.

- **Phase 4.5 portable config bundles.** A new org-level **Backups** area exports every app's configuration as a single signed, passphrase-protected `.sohwe.json` document and restores it on the same or a different Sohwe instance. Bundles are config-only — app settings, volume *definitions* (mount paths, not data), alert destinations, and optionally re-encrypted env vars; no git mirrors and no volume data. `@sohwe/bundler` derives a 32-byte key from the passphrase via scrypt (salt stored in the bundle), AES-256-GCM-encrypts each app's env vars, and HMAC-SHA256-signs the manifest so a wrong passphrase or any tampering is rejected at restore. Org-scoped routes live under `/api/backups`: destination CRUD (`/destinations`), bundle history (`GET /api/backups`), `POST /api/backups/export`, `POST /api/backups/restore/{preflight,apply}`, and schedule CRUD (`/schedules`). Restore is non-destructive by default: apps land in `idle` (nothing deploys, no Traefik routers, no ACME cert requests until the user deploys), and slug collisions are resolved by an explicit `rename` / `overwrite` / `skip` policy chosen after a preflight summary (which reports env var *key counts*, never values). New Prisma models: `BackupDestination`, `Bundle`, `BackupSchedule`.

- **Backup destinations and scheduling.** `@sohwe/backups` implements local-filesystem and S3-compatible destinations (`@aws-sdk/client-s3`; works with AWS, MinIO, R2, Spaces) with credentials encrypted at rest. Scheduled exports run on a `backup` BullMQ queue owned by the worker: a 60s repeatable tick enqueues due cron schedules, and `retentionCount` keeps the newest N bundles per schedule, pruning both the destination file and the history row. Manual export and restore still run synchronously in the API.

- **Phase 5 git-push deploys.** Push to the tracked branch and the app deploys. Sohwe does not ship a central GitHub App — each instance creates its own through GitHub's **app manifest flow**, so the operator owns the app, its private key, and its webhook secret. A new org-level **Git** area walks through it: create the app, install it, review the repositories the installation can read, and disconnect. Credentials (`pem`, `webhookSecret`, `clientSecret`) are stored encrypted with `SOHWE_ENCRYPTION_KEY` and never returned by any endpoint.

  The app requests the minimum surface: `contents: read`, `metadata: read`, `statuses: write`, and the `push` event only.

  - **Private repositories build.** The worker mints a short-lived installation token (cached per installation, refreshed a minute before expiry) and clones through it. The tokenized URL never reaches a build log, and because git echoes the remote in its error output, every failure derived from a clone is redacted before it can reach the log stream, the deployment row, or an alert.
  - **Signed webhook** at `POST /api/webhooks/github`, registered with a raw-buffer body parser so `X-Hub-Signature-256` is verified against the exact bytes GitHub signed. Nothing in the payload is trusted before the HMAC matches. Tag pushes and branch deletions are ignored; removing the installation clears the stored installation id.
  - **Commit statuses** are reported back for every deploy with a known commit (pending → success/failure), linking to the deployment page when `SOHWE_PUBLIC_URL` is set. Best-effort: a status failure never fails a deploy.
  - **Auto-deploy toggle** per app, plus a repository picker in the new-application dialog that fills in the clone URL and default branch. Enabling auto-deploy is refused with a specific reason when it could not work (non-GitHub remote, no app connected, app not installed) rather than silently doing nothing.

  New `@sohwe/github` package (no Octokit or jsonwebtoken dependency — JWTs are signed with `node:crypto` and calls use global `fetch`), with 54 unit tests over URL parsing, ref parsing, signature verification, JWT claims, push-payload narrowing, and manifest permissions.

  New Prisma model `GitHubApp` (one per organization); `Application` gains `repoFullName` and `autoDeploy`, and `Deployment` gains `trigger` (`manual` | `push` | `rollback`). The migration is purely additive.

  **New env var `SOHWE_PUBLIC_URL`** — the externally reachable base URL of the instance, threaded through `scripts/install.sh` and `docker-compose.prod.yml`. It is baked into the GitHub App's webhook and redirect URLs when GitHub creates the app, so a wrong value means recreating the app; the installer derives it from `SOHWE_HOST` and the dashboard warns when it is unset. The API validates it at boot and falls back to the forwarded request origin.

- **Webhook delivery log.** The Git settings page now lists recent inbound GitHub deliveries and what Sohwe did with each: deployed, no action (with the reason — no linked app, a different tracked branch, or auto-deploy off), rejected, or errored. Diagnosing a push that did not deploy previously meant reading the API's stdout. Deliveries are recorded on every path *including* signature rejection, since a mismatched webhook secret is the most common cause and otherwise looks like complete silence. Nothing derived from an unverified payload is stored — rejected rows carry only the headers GitHub sends in the clear. History is capped at the newest 200 rows per organization. New Prisma model `WebhookDelivery`; the migration is purely additive (one `CREATE TABLE`, two indexes, one foreign key).

### Changed

- **Configurable apps base domain.** `SOHWE_BASE_DOMAIN` is now an installer prompt (defaults to the dashboard host, falling back to `sohwe.localhost`) written to `/etc/sohwe/sohwe.env` and plumbed into both api and worker via `docker-compose.prod.yml`'s shared env block — the worker always read it for Traefik labels, but it was never *set* anywhere except hardcoded defaults. The api serves it back over `GET /api/config` (public, no-auth, allowed through the setup gate). The dashboard's hardcoded `lib/constants.ts#baseDomain` is replaced by `lib/config.ts#useBaseDomain`, a TanStack Query hook with `staleTime: Infinity`. An operator can now point a real wildcard domain at the box (`*.apps.example.com A <ip>`) and get correct URLs without rebuilding any image.

- **Versioned database migrations replace `db push --accept-data-loss`.** `sohwe migrate` — which `sohwe update` and the installer both call — now runs `prisma migrate deploy`, replaying reviewed SQL from the new `packages/db/prisma/migrations` directory instead of force-pushing the schema. Previously any upgrade that narrowed or removed a column would drop that column's data without prompting.

  Two migrations are committed: `20260722000000_init` reproduces the schema shipped by every published tag through v0.3.8, and `20260722000100_observability_and_backups` adds the Phase 4 + 4.5 tables (`alert_destinations`, `backup_destinations`, `bundles`, `backup_schedules`). The second is **purely additive** — four `CREATE TABLE`s plus indexes and foreign keys, with no `ALTER` against existing tables — so upgrading an existing install does not touch existing rows.

  **Upgrading from v0.3.8 or earlier requires no manual step.** Those databases were created by `db push` and have no `_prisma_migrations` table, so `prisma migrate deploy` refuses with `P3005`. `sohwe migrate` detects that specific error and baselines the database by marking `init` as already-applied — a history row only, no DDL — then applies the remaining migrations. Because every tag through v0.3.8 shipped a byte-identical schema, this state is unambiguous. Any other migration failure is surfaced and does not trigger a baseline.

  Migrations are forward-only. `sohwe rollback` restores the previous images but does not revert schema changes; additive migrations leave the older version working, and any future destructive migration will be called out here.

- **Migrations now run automatically as a one-shot `migrate` service.** `docker-compose.prod.yml` gained a `migrate` service that runs `prisma migrate deploy` — auto-baselining a pre-v0.3.8 database when it sees `P3005` — and then exits. `api` and `worker` depend on it with `condition: service_completed_successfully`, so every `docker compose up -d` brings the schema forward before any application code connects, and a failed migration blocks startup instead of leaving the API running against a stale schema. The logic lives in `packages/db/bin/migrate-deploy.mjs` (also runnable with `--status`), which ships inside the API image; the CI `migrations` job now exercises that exact script on both the fresh-install and the pre-v0.3.8 upgrade path rather than re-implementing its steps. `sohwe migrate` is unchanged and still works.

- New `sohwe migrate-status` subcommand shows applied vs pending migrations.
- New root scripts: `pnpm db:migrate`, `pnpm db:migrate:deploy`, `pnpm db:migrate:status`. `pnpm db:push` remains for throwaway scratch databases but must not be used for committed schema changes.

### Fixed

- **Two apps could share a Traefik router and cross-route each other's traffic.** The router, service, and middleware names were derived by stripping every non-alphanumeric character from the app slug, which is lossy: `my-app` and `myapp` are two distinct, individually valid slugs that both reduced to `wmyapp`. Deploying both left Traefik holding conflicting definitions for one router name, so one app's traffic could be served by the other. Names now carry an 8-character digest of the full slug, keeping them readable and distinct. Labels are rewritten on every deploy, so existing apps pick this up the next time they deploy.

- **`SOHWE_CERT_RESOLVER` had no effect in production.** The worker reads it when putting TLS labels on deployed apps, but it was never written to `/etc/sohwe/sohwe.env` by the installer nor passed through the shared env block in `docker-compose.prod.yml`, so it silently stayed on the `letsencrypt` default no matter what an operator set. It is now threaded through both, documented in the README alongside `SOHWE_HTTPS_ENABLED`, and defaults to the resolver the production compose file declares.

- **Build logs no longer cost O(n²) to write, or grow without bound.** Every 200 ms the worker read the accumulated `Deployment.buildLogs` column back, concatenated the new lines, and wrote the whole thing again, so a long build rewrote megabytes hundreds of times and the stored row grew without limit — and the SSE route replays that row in full on every reconnect. The log sink now appends in the database (`build_logs = COALESCE(build_logs,'') || $1`, no read-back) and caps the stored copy at 512 KiB, keeping the first 128 KiB and the most recent 384 KiB with a notice marking the dropped middle. Once truncating it rewrites at most once every 3 s, since that path costs the full capped size. Live streaming over Redis is unaffected and still carries every line. The log is also cleared when a deployment starts building, so a retried job no longer stacks its output onto the previous attempt's.

### Security

- **Rate limiting on the unauthenticated credential endpoints.** `POST /api/auth/login` and `POST /api/setup/unlock` are now limited to 10 requests per minute per client IP (`@fastify/rate-limit`), returning `429` with `Retry-After` past the threshold. The API runs with `trustProxy` so the limit keys off the real client IP forwarded by Traefik/nginx rather than the proxy's address. Other routes — including the dashboard's frequent metrics polling and long-lived log SSE — are unaffected.
- **Fail-fast environment validation at boot.** The API and worker now validate their environment before opening any socket or connection and exit with a clear, aggregated message if it is wrong. This closes a silent-failure mode where an unset `SESSION_SECRET` left the setup-gate cookie unsigned (so unlock returned `{ok:true}` but never actually unlocked), and surfaces a missing or wrong-length `SOHWE_ENCRYPTION_KEY` at startup instead of mid-deploy when the worker first decrypts env vars.
- **Setup-gate cookie now expires server-side.** The gate cookie signs an issue timestamp; verification now enforces it against a 7-day lifetime (matching the cookie's `Max-Age`), rejecting stale, future-dated, or timestamp-less cookies. Previously the timestamp was signed but never checked, so a leaked gate cookie was valid indefinitely.
- **Configurable CORS; no dev origin shipped to production.** The API's allowed CORS origin is read from the optional `SOHWE_CORS_ORIGIN` (comma-separated list, or `*`). When unset it defaults to disabled under `NODE_ENV=production` (the dashboard is same-origin through nginx) and to `http://localhost:3000` otherwise. Previously `http://localhost:3000` was hardcoded into the production image.
- **Expired sessions are swept.** The API deletes expired session rows on boot and hourly thereafter, so the table no longer accumulates 30-day-lived rows indefinitely. Expiry was already enforced at read time; this reclaims the storage.

### Tests

- **Every workspace package now has tests — 350 in total, up from 103.** All use the same Node runner via `tsx` and run in CI.

  - **API HTTP tests** (`apps/api/src/routes.test.ts`, 38): real requests through `app.inject()` covering first-run setup, login and session lifecycle, auth rate limiting, the setup gate (including a forged cookie), organization scoping — a second organization's app is invisible to the list and 404s on every mutating route — and the promises that encrypted env vars never appear in a response, that values stay masked without `reveal`, and that env is unrecoverable from the stored column. Requires a throwaway Postgres named by `TEST_DATABASE_URL`; the suite skips itself when that is unset, so `pnpm test` still works without Docker.
  - **Worker container spec** (89 total): Traefik label construction, TLS opt-in, the router-name collision above, volume mounts, resource-limit conversion, and the full `docker.createContainer` argument — plus the build log sink and failure summarizer.
  - **Shared packages**: `@sohwe/types` request schemas and Docker naming helpers (37), `@sohwe/queue` channel and key names, which are a cross-process wire contract (12), `@sohwe/backups` destination resolution and bundle filenames (18), and `@sohwe/builder` engine selection (10).

  Supporting changes: the Fastify instance is now assembled by `buildServer` in `apps/api/src/server.ts`, so it can be built without binding a port (`index.ts` keeps only process concerns); routing and container-shape decisions moved from `runDeploy` into the pure `apps/worker/src/container-spec.ts`; the deploy queue and stats Redis client are closed on `app.close()`, which also makes SIGTERM shutdown complete; and the CI `verify` job gained Postgres and Redis service containers.

- **First unit tests, on the crypto and bundle-format code.** `@sohwe/crypto` (32 tests: encrypt/decrypt round-trips, GCM tamper/wrong-key rejection, `decryptJson` validation, scrypt key derivation, HMAC verification) and `@sohwe/bundler` (17 tests: canonicalization, build/parse round-trips, wrong-passphrase and tamper rejection) now have tests using Node's built-in runner via `tsx`, run by `pnpm test` and wired into the CI `verify` job. The bundler suite includes a **frozen golden bundle** produced by a real export, which must keep parsing forever — it fails loudly if the on-disk bundle format changes incompatibly, protecting cross-instance restore.

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
