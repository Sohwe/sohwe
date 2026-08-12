# Sohwe — Architecture Guide

An open-source, self-hostable deployment platform — a spiritual cousin to Coolify / Dokploy / Railway that you run on your own servers. Git-push deploys, automatic HTTPS, live logs, custom domains, stateful apps.

Licensed **AGPL-3.0** (see [`LICENSE`](./LICENSE)).

This document describes how Sohwe is built and why. For what to run, see [`README.md`](./README.md); for what has shipped, see [`ROADMAP.md`](./ROADMAP.md) and [`CHANGELOG.md`](./CHANGELOG.md).

> Phases 0 through 6 are implemented. This guide used to carry a full build-from-scratch tutorial for those phases; that walkthrough was removed once the code became the better reference — recover it from git history if you need it. The only design sketch left below is for Phase 7, which has **not** been built.

## Table of Contents

1. [Vision & Scope](#vision--scope)
2. [Phased Roadmap](#phased-roadmap)
3. [Architecture Overview](#architecture-overview)
4. [Tech Stack & Decisions](#tech-stack--decisions)
5. [Prerequisites](#prerequisites)
6. [As Built: Observability](#as-built-observability)
7. [As Built: Portable Bundles](#as-built-portable-bundles)
8. [As Built: Git-Push Deploys](#as-built-git-push-deploys)
9. [As Built: Multi-User](#phase-6--multi-user)
10. [Phase 7 — Managed Datastores](#phase-7--managed-datastores)
11. [Cross-Cutting Concerns](#cross-cutting-concerns)
12. [Development Workflow](#development-workflow)
13. [Troubleshooting](#troubleshooting)
14. [Resources](#resources)

---

## Vision & Scope

Sohwe lets you connect a Git repo and get a running, HTTPS-terminated container with a URL — across any runtime, with persistent volumes, encrypted env vars, live logs, and crash alerts.

### In scope for v1

- Single-server deployment
- Deploy apps from Git repos (manual button + push-to-deploy)
- Dockerfile builds and Nixpacks auto-detection
- Free wildcard subdomain (`*.<SOHWE_BASE_DOMAIN>`) + custom domains
- Automatic HTTPS via Let's Encrypt
- Persistent volumes (one mount per path)
- Encrypted environment variables
- Live log tail + build logs + basic CPU/memory
- **Dashboard file browser** for the **running** app container (list directories, preview files) so users can inspect the filesystem without SSH
- Single owner user at setup, invitable members afterwards (copy-link invitations; owner/admin/member roles)

### Explicitly deferred to v2+

- Databases-as-a-service (one-click Postgres/Redis) — feasible on the same VPS, but deferred until the v1 control-plane scope is stable. Sketched in [Phase 7](#phase-7--managed-datastores).
- Multi-node / cluster scheduling
- Preview deployments per pull request
- Log history beyond basic storage
- Prometheus / Grafana / Loki integration
- Billing / hosted SaaS version
- Full teams/orgs with fine-grained permissions

---

## Phased Roadmap

| Phase | Goal | Status |
| --- | --- | --- |
| **0. Foundation** | Monorepo, DB schema, auth, empty dashboard | Shipped |
| **1. First Deploy** | Clone repo → Docker build → run container → public URL | Shipped |
| **2. Broad Runtimes** | Nixpacks, custom commands, custom domains | Shipped |
| **3. Stateful Apps** | Volumes, encrypted env vars, resource limits | Shipped |
| **3.5. Packaging & Install** | Production images, compose stack, `curl \| bash` installer, `sohwe` CLI | Shipped (3 manual VPS checks open) |
| **4. Observability** | Live logs, build logs, CPU/mem, crash alerts | Shipped |
| **4.5. Portable Bundles** | Config export/restore, local + S3 destinations, scheduled exports | Shipped |
| **5. Git-Push Deploys** | GitHub App, webhooks, auto-deploy | Shipped (manual e2e check open) |
| **6. Multi-User** | Invites, roles, audit log | Shipped (instance-host file browser deferred) |
| **7. Managed Datastores** | One-click Postgres/Redis, private bindings | Post-v1 / v2 |

`ROADMAP.md` is the authoritative per-item checklist with file-level evidence.

---

## Architecture Overview

### Services

```
                      ┌──────────────────────┐
                      │       Dashboard       │  (Vite + React SPA, port 3000)
                      └──────────┬────────────┘
                                 │ REST + SSE
                                 ▼
                      ┌──────────────────────┐
                      │         API           │  (Fastify, port 3001)
                      │  - Auth / setup gate  │
                      │  - CRUD               │
                      │  - Enqueue jobs       │
                      │  - SSE log streams    │
                      └────┬──────────────┬───┘
                           │              │
                     reads │              │ enqueues
                           ▼              ▼
                      ┌─────────┐   ┌───────────┐
                      │Postgres │   │   Redis   │
                      └────▲────┘   └─────▲─────┘
                           │              │
                           │  reads       │ consumes
                      ┌────┴──────────────┴───┐
                      │       Worker          │  (BullMQ consumer)
                      │  - Git clone          │
                      │  - Build (Docker/Nix) │
                      │  - Run container      │
                      │  - Stream logs/stats  │
                      │  - Crash watcher      │
                      │  - Backup scheduler   │
                      │  - Commit statuses    │
                      └──────────┬────────────┘
                                 │ dockerode
                                 ▼
                      ┌──────────────────────┐
                      │     Docker engine     │
                      │  ┌─────┐  ┌─────┐    │
                      │  │app-a│  │app-b│... │   (Traefik-labelled containers)
                      │  └─────┘  └─────┘    │
                      └──────────┬────────────┘
                                 │
                      ┌──────────▼────────────┐
                      │       Traefik         │  (80/443, auto-HTTPS)
                      │  Auto-discovers apps  │
                      │  via Docker labels    │
                      └───────────────────────┘
```

### Monorepo Layout

```
sohwe/
├── apps/
│   ├── api/                # Fastify API
│   ├── worker/             # BullMQ consumer + log/stats/crash/backup subsystems
│   └── dashboard/          # Vite + React SPA
├── packages/
│   ├── db/                 # Prisma schema + client (shared)
│   ├── types/              # Shared Zod schemas + Docker naming helpers
│   ├── queue/              # BullMQ job defs, Redis config, channel/key helpers
│   ├── builder/            # Dockerfile / Nixpacks image build wrapper
│   ├── crypto/             # AES-256-GCM (env at rest, shared API + worker)
│   ├── bundler/            # Signed, passphrase-encrypted config bundles
│   ├── backups/            # Destination storage (local + S3) + export orchestration
│   └── github/             # GitHub App client: manifest flow, tokens, webhooks, statuses
├── docker/                 # Production Dockerfiles + dashboard nginx config
├── scripts/                # install.sh + host `sohwe` CLI
├── docker-compose.dev.yml
├── docker-compose.prod.yml
└── docker-compose.https.yml
```

### Key Data Flow: Deploying an App

1. User clicks **Deploy** in the dashboard.
2. Dashboard calls `POST /api/applications/:id/deploy`.
3. API creates a `Deployment` row (`status: pending`), enqueues a `deploy` job, returns 202.
4. Dashboard opens SSE to `/api/deployments/:id/logs`.
5. Worker clones the repo, runs Nixpacks or `docker build`, tags the image.
6. Worker stops the old container, starts the new one with Traefik labels, attaches it to the proxy network and the per-app internal network.
7. Worker updates `Deployment.status`; each log line goes Redis pub/sub → SSE → dashboard.
8. Traefik auto-discovers the container and routes `<slug>.<SOHWE_BASE_DOMAIN>` to it.

---

## Tech Stack & Decisions

| Layer | Choice | Why |
| --- | --- | --- |
| **Package manager** | pnpm + workspaces | Fast, disk-efficient, first-class monorepo support |
| **Build orchestrator** | Turborepo | Parallel `dev`/`build`, dep-aware caching |
| **Language** | TypeScript everywhere | Shared types between API / worker / dashboard |
| **API** | Fastify | Fast, built-in schema validation, native streaming, pino logger |
| **DB** | PostgreSQL 16 | Prod-grade from day one; SQLite would hurt later |
| **ORM** | Prisma | Type-safe, good DX |
| **Queue** | BullMQ + Redis | Standard for Node job queues |
| **Worker** | Separate Node service | Isolation; scales independently |
| **Dashboard** | Vite + React + TanStack Query/Router | Pure SPA, fast HMR, no SSR complexity |
| **Validation** | Zod + `fastify-type-provider-zod` | One schema shared with the frontend |
| **Auth** | Server-side sessions + Argon2id | Don't roll your own sessions |
| **Reverse proxy** | Traefik v3 | Auto-discovers containers via Docker labels, Let's Encrypt built in |
| **Build engine** | Nixpacks (primary), user Dockerfile (override) | Auto-detects Next.js/Node/Python/Go/Rust/static |
| **Container control** | dockerode | Direct Docker Engine API access |
| **Log streaming** | SSE + Redis pub/sub | Simpler than WebSockets for one-way streams |
| **Secrets** | AES-256-GCM with `SOHWE_ENCRYPTION_KEY` | Env vars encrypted at rest |

Nixpacks produces a **container image** from the repo checkout; it does not require a `Dockerfile` in the app's repo unless the user opts into Dockerfile build mode.

### Rejected options (for the record)

- **Express** — streaming logs and schema validation are first-class in Fastify.
- **Next.js dashboard** — overkill for a pure SPA; SSR complicates log streaming.
- **Caddy** — requires regenerating the Caddyfile on every deploy; Traefik's label-based Docker provider fits a dynamic platform better.
- **SQLite for v1** — painful when multi-node comes up.
- **Buildpacks (Paketo/Heroku)** — more battle-tested than Nixpacks but heavier and slower.

---

## Prerequisites

- **WSL2 with Ubuntu** (strongly recommended on Windows — Docker, dockerode, Nixpacks, and Unix sockets are all smoother on Linux)
- **Docker Desktop** (WSL2 backend) or Docker Engine inside WSL
- **Node.js 24 LTS** — current Active LTS, supported through April 2028
- **pnpm 9+**
- **Git**

Node 24 brings unflagged TypeScript type-stripping, built-in `--env-file`, stable `node --run`, a stable test runner and permission model, and a built-in WebSocket client.

On Windows: `wsl --install -d Ubuntu`, then install Node/pnpm inside Ubuntu and open the project over the WSL remote. Run every command inside WSL. See [`DEVELOPMENT.md`](./DEVELOPMENT.md) for the native-Windows path (which works, with a Nixpacks caveat).

---

## As Built: Observability

- **Runtime logs.** The worker attaches to managed containers via dockerode and publishes stdout/stderr to Redis on the channel from `appLogChannelName()` in `@sohwe/queue`. It re-attaches to already-running managed containers on startup. The API serves `GET /api/applications/:id/logs` as org-scoped SSE, replaying recent Docker logs before following the channel.
- **Build logs.** Unchanged since Phase 1: Redis pub/sub plus persisted `Deployment.buildLogs` for replay on reconnect. Reachable from the app **Logs** tab via a Runtime / Last build toggle.
- **Metrics.** The worker samples one-shot Docker stats every ~3s for running managed containers and writes `{cpuPercent, memUsedBytes, memLimitBytes, memPercent}` to `appStatsKey()` with a **10s TTL**. `GET /api/applications/:id/stats` is a polling read returning `{ running: false }` when no fresh sample exists.
- **Crash alerts.** The worker watches Docker `die`/`oom` events for managed containers. On non-zero exit or OOM kill it marks the app `crashed` and POSTs to each enabled `AlertDestination` (`slack` / `discord` / `generic`), managed under `/api/applications/:id/alert-destinations`. Payloads carry app name/slug, event, exit code, container id, and timestamp — never env values.

---

## As Built: Portable Bundles

> This section describes what shipped. An earlier draft of this guide specified a different design (`.tar.zst` archive, ed25519 signatures, Argon2id KDF, `/api/bundles/*` routes, BullMQ-job export with SSE progress). **None of that is what exists** — the details below are authoritative.

**Format.** A bundle is a single JSON document (`.sohwe.json`), not an archive. `packages/bundler` owns it: `format: "sohwe-backup"`, `version: 1`.

**Crypto.**
- Key derivation: **scrypt** from the user's export passphrase, with the salt stored in the bundle.
- Env vars: **AES-256-GCM**, re-encrypted under the passphrase-derived key. The instance master key never enters a bundle.
- Integrity: **HMAC-SHA256** over the manifest. A wrong passphrase or any tampering is rejected at restore.

**Scope — config only.** App settings, volume *definitions* (mount paths, not data), alert destinations, and optionally re-encrypted env vars. No git mirrors, no volume contents, no images. Full-state backup remains deferred (see below).

**Routes** — all org-scoped under `/api/backups`:

```
GET    /api/backups                       # bundle history
POST   /api/backups/export                # download, or write to a destination
POST   /api/backups/restore/preflight     # summary + collision report
POST   /api/backups/restore/apply
GET    /api/backups/destinations
POST   /api/backups/destinations
DELETE /api/backups/destinations/:destId
GET    /api/backups/schedules
POST   /api/backups/schedules
PATCH  /api/backups/schedules/:scheduleId
DELETE /api/backups/schedules/:scheduleId
```

**Destinations.** `packages/backups/src/storage.ts` implements local-path and S3-compatible targets (`@aws-sdk/client-s3`; works with AWS, MinIO, R2, Spaces). S3 credentials are encrypted at rest — resolve destinations through the existing helper rather than reading config rows directly.

**Restore safety.** Non-destructive by default: restored apps land in `idle`, so nothing deploys, no Traefik routers appear, and no ACME certs are requested until the user acts. Slug collisions resolve by an explicit `rename` / `overwrite` / `skip` policy chosen after preflight. Preflight reports env var **key counts**, never values.

**Scheduling.** Manual export/restore run synchronously in the API. Scheduled exports run on a `backup` queue owned by the worker (`apps/worker/src/backups.ts`): a 60s repeatable tick enqueues due cron schedules; `retentionCount` keeps the newest N bundles per schedule, pruning both the destination file and the history row.

**Prisma models.** `BackupDestination`, `Bundle`, `BackupSchedule` (the schedule stores an encrypted passphrase plus `includeSecrets`).

### Deferred to Phase 5.5 (full-state backup, post-GA)

- Postgres dump and restore inside the bundle
- Raw volume tar + per-volume hooks (`pg_dump`, `mysqldump`, `redis-cli --rdb`)
- `docker save` of built images
- Incremental volume chunks (content-addressable storage)
- Restore drill (dry-run mode)
- Optional per-app git mirrors

---

## As Built: Git-Push Deploys

Goal, met: push to the tracked branch → it deploys.

**No central app.** Sohwe is self-hosted, so there is no Sohwe-operated GitHub App to install. Each instance creates its own through GitHub's **app-manifest flow**, which means the operator owns the app, its private key, and its webhook secret, and Sohwe never holds credentials for anyone else's instance. The trade is that connecting is a three-hop browser flow instead of a single "Install" button:

1. `GET /api/github/manifest/new` returns a self-submitting form that POSTs the manifest to `github.com/settings/apps/new` (or the org equivalent), carrying a signed, 15-minute `state`.
2. GitHub creates the app and redirects to `GET /api/github/manifest/callback` with a single-use code. Exchanging it yields the app id, PEM, webhook secret, and client credentials, which are AES-256-GCM encrypted with `SOHWE_ENCRYPTION_KEY` into `GitHubApp.credentialsEncrypted`.
3. The operator installs the app and picks repositories; GitHub returns them to `GET /api/github/setup/callback`, which verifies the supplied `installation_id` really belongs to this app (via `GET /app/installations/:id` with an app JWT) before storing it.

Steps 2 and 3 are top-level GET navigations from GitHub, so the `SameSite=Lax` session cookie rides along and both routes stay authenticated.

**Permissions** are the minimum the feature needs: `contents: read` (clone), `metadata: read` (mandatory alongside contents), `statuses: write` (report results), subscribed to `push` only.

**Webhook.** `POST /api/webhooks/github` is registered inside an encapsulated Fastify scope with a raw-buffer content-type parser, because `X-Hub-Signature-256` must be verified against the exact bytes GitHub signed — a re-serialized object will not match. Which app signed a delivery cannot be known before verification (the payload is untrusted), so the handler tries each connected app's secret; a self-hosted instance has one, making this a single HMAC. Only after the HMAC matches is the payload parsed. Pushes to a tracked branch enqueue a deploy for every matching `autoDeploy` app; tag pushes and branch deletions are ignored, and `installation` deletion clears the stored installation id.

Matching is an indexed lookup on `Application.repoFullName` (`owner/repo`, denormalized from `gitRepo` on create, backfilled at boot for pre-Phase-5 rows) rather than parsing every repo URL per delivery.

**Private clones.** The worker mints an installation token (cached per installation, refreshed a minute before its hour expires) and clones `https://x-access-token:<token>@github.com/...`. Token hygiene is the sharp edge: the clean `gitRepo` is what gets logged, and because git echoes the remote in its error output, every failure derived from a clone passes through a redactor before reaching the build log, the deployment row, or the rethrown error.

**Commit statuses** are posted for any deploy with a known sha — pending on clone, success once the container runs, failure on error — linking to the deployment page when `SOHWE_PUBLIC_URL` is set. Reporting is best-effort and swallows its own errors; a revoked installation must not fail a working deploy.

**`SOHWE_PUBLIC_URL`** is the one new env var. The manifest needs absolute webhook and redirect URLs, and they are fixed at app-creation time, so a wrong value means deleting the app on GitHub and starting over. The API validates it at boot, falls back to the forwarded request origin, and the dashboard warns when the value was guessed.

`@sohwe/github` holds the whole client with no Octokit or jsonwebtoken dependency — app JWTs are signed with `node:crypto` and calls use global `fetch`. Its db-aware helpers live in a separate `./resolve` entry point so the core stays pure and unit-testable.

**Not covered:** no webhook delivery log (debugging a missed push means reading API logs), and GitHub only — GitLab/Gitea would need their own credential and webhook paths.

---

## Phase 6 — Multi-User

*As built.*

**Roles.** Three, strictly ordered, so every check is "at least this role" rather than a per-permission matrix: `owner` > `admin` > `member`. `apps/api/src/rbac.ts` exports `requireRole(min)`, a Fastify preHandler that authenticates first when it runs alone — a route can never end up role-checked but unauthenticated. Unknown role strings rank 0, below `member`, so a downgrade or a hand-edited row fails closed rather than open. `apps/dashboard/src/lib/roles.ts` mirrors the ordering to hide controls the caller cannot use; it is cosmetic, and the API re-checks everything.

The dividing line is not read-vs-write, it is **can this surface expose a secret**. Env vars are admin-and-above even for the masked listing, because `maskedPreview` still shows part of every value. So are the container file browser (it reaches config files, mounted volume data, and `/proc/self/environ`), alert destinations (a Discord/Slack webhook URL is a bearer credential for someone's channel), backups (bundles carry re-encrypted env vars), and the GitHub connection. `member` gets the app list, deployments, logs, metrics, volume definitions, the member roster — and deploy/rollback, because operating existing apps is the point of the role.

**Invitations.** No email. A self-hosted instance would need an SMTP relay or a third-party API key just to add a second user, so instead an admin mints a link and delivers it themselves. `Invitation` stores only the SHA-256 of a 32-byte token; the raw link exists exactly once, in the create response. That makes a lost link unrecoverable by design — revoke and reissue. Acceptance claims the row with a conditional `updateMany` inside the same transaction that creates the user, so two people opening one link cannot both get an account, and the new member is signed in immediately. Invitations grant `admin` or `member`; `owner` is only ever conferred by an existing owner.

**Invariants.** The organization can never be left without an owner (checked on both demotion and removal), nobody may change their own role or delete their own account, and an admin cannot remove an owner. Removing a user cascades their sessions, so access ends everywhere at once. Role changes need no re-login: the role is read from the database on every request through the session lookup.

**Audit log.** `AuditLog` is append-only and org-scoped, written best-effort at the call sites — a failed audit write must never turn a completed action into a failed request. Two rules govern what goes in it: nothing secret, and enough to be useful without it. Env events carry key *names*, counts, and which keys were added, removed, or changed; backup events carry app counts and destination kinds, never passphrases or S3 credentials; GitHub events carry the public App identity, never the PEM or webhook secret; invitation events never carry the token. The actor's email is denormalized onto the row so removing a user leaves the trail readable instead of erasing it — `actorId` goes null, `actorEmail` survives, and the UI marks the actor as removed.

**Not covered:** an **instance host** file browser — browsing paths on the Sohwe server itself, distinct from the existing *container* file browser. It stays deferred, and when it lands it needs the security model sketched for it: a strict root-path allowlist, `..` rejection, and an audit entry for every list and read. There is also no org switcher, because a user still belongs to exactly one organization.

---

## Phase 7 — Managed Datastores

*Post-v1 / v2 candidate. Design sketch.*

Goal: click **Create Postgres** or **Create Redis**, get a private service on the host, and bind it to an app without SSH. Builds on Phase 3's per-app internal networks and volumes. A managed datastore is not deployed from Git — it is a Sohwe-owned container using an official image, a named volume, generated credentials, and Sohwe labels.

**Flow.** API creates a `Datastore` row (`status: provisioning`), generates and encrypts credentials, enqueues a job. Worker creates `sohwe_datastore_<id>_data`, starts `postgres:<version>` or `redis:<version>` with no public ports, and attaches it to the bound app's internal network. Binding injects `DATABASE_URL` / `REDIS_URL` / a custom key into the app's encrypted env vars; the app picks it up on next deploy.

**Data model.** `Datastore` (org-scoped: kind, name, slug, status, image, `credentialsEncrypted`, storage/CPU/memory hints) and `DatastoreBinding` (datastore ↔ application ↔ `envKey`, unique together).

**API surface.** CRUD under `/api/datastores`, plus `/rotate-password`, `/bindings`, and `/connection-string`. The connection-string endpoint behaves like env-var reveal: authenticated, intentional, audited, never in list responses.

**Worker.** Create/label/start/stop/delete containers and volumes, apply limits, attach private networks, health-check with `pg_isready` / `redis-cli ping`, rotate credentials.

**Constraints.** No public TCP exposure by default. Generated passwords encrypted at rest and absent from logs and health errors. Deleting a datastore destroys its volume — require explicit confirmation. Datastore *config* belongs in config bundles; raw contents wait for full-state backup. This feature turns Sohwe from a deploy control plane into a data host, so backup/restore docs must be solid before release.

**Open questions.** Private-only or optional public TCP? Backups in the first release or with full-state bundles? Redis persistent (`appendonly yes`) or ephemeral by default? How much DB administration belongs in v2?

---

## Cross-Cutting Concerns

### Authentication

- Sessions stored server-side in the `sessions` table. HttpOnly, SameSite=Lax cookie. No JWTs.
- Passwords hashed with **Argon2id**.
- Session and setup-gate cookies derive `Secure` from `SOHWE_HTTPS_ENABLED`, not `NODE_ENV` — HTTP-only installs must be able to store them.
- Rate limit login with `@fastify/rate-limit`.

### Secrets Encryption

`packages/crypto` wraps AES-256-GCM with `SOHWE_ENCRYPTION_KEY` (32 bytes, base64). Ciphertext layout is `iv(12) || tag(16) || ciphertext`. Both the API and the worker need the same key — the worker cannot decrypt env for `docker create` without it.

Rotate `SOHWE_ENCRYPTION_KEY` only via a migration script that re-encrypts all rows; never in place.

### Docker Labels & Networking

Every managed container gets:

```
sohwe.managed=true
sohwe.app=<app-id>
sohwe.deployment=<deployment-id>
traefik.enable=true
traefik.http.routers.<slug>.rule=Host(`<host>`)
traefik.http.routers.<slug>.entrypoints=websecure
traefik.http.routers.<slug>.tls.certresolver=letsencrypt
traefik.http.services.<slug>.loadbalancer.server.port=<internal-port>
```

Networks:

- `sohwe_proxy` — shared network that Traefik and every managed container attach to.
- `sohwe_app_<app-id>_net` — per-app internal bridge network.

Naming helpers for volumes (`sohwe_app_<appId>_<volumeId>`) and networks live in `@sohwe/types`; don't hand-build these strings.

---

## Development Workflow

```bash
pnpm dev                      # api + worker + dashboard in parallel
pnpm --filter @sohwe/api dev  # just the API
pnpm db:studio                # Prisma Studio at http://localhost:5555
pnpm db:migrate               # Create + apply a migration for a schema change
pnpm typecheck
docker compose -f docker-compose.dev.yml logs -f
```

Add a dependency to one workspace with `pnpm --filter @sohwe/api add some-package`.

**On migrations:** schema changes are versioned SQL in `packages/db/prisma/migrations`. Dev uses `prisma migrate dev` (`pnpm db:migrate`) to author one; production replays the identical file via `sohwe migrate` → `prisma migrate deploy`. Migrations are forward-only — there are no down-migrations, and `sohwe rollback` restores images but not schema.

Databases created by v0.3.8 or earlier predate the migrations directory. Because every published tag through v0.3.8 shipped a byte-identical schema, that state is unambiguous, and `sohwe migrate` baselines it automatically on first run: it marks `20260722000000_init` as already-applied (a row in `_prisma_migrations`, no DDL) and then applies only the later migrations.

---

## Troubleshooting

**`pnpm dev` says a workspace package isn't found** — run `pnpm install` from the repo root after creating new packages.

**Prisma Client errors after a schema change** — `pnpm db:migrate && pnpm db:generate`.

**Traefik returns 404 for a deployed app** — is the container on `sohwe_proxy`? Does the router rule match the host you're visiting? Is `SOHWE_BASE_DOMAIN` what you expect (check `GET /api/config`)?

**`argon2` fails to build on Node 24** — install build tools (`build-essential`, `python3`) and `pnpm install --force`, or swap to `@node-rs/argon2` (Rust + napi, same algorithm, slightly different API).

**Docker socket permission denied from WSL** — `sudo usermod -aG docker $USER && newgrp docker`.

**Port 3000/3001 in use** — `ss -ltnp | grep -E '3000|3001'`, then kill the PID.

---

## Resources

- [Fastify](https://fastify.dev/docs/latest/) · [Prisma](https://www.prisma.io/docs) · [BullMQ](https://docs.bullmq.io/)
- [Traefik v3](https://doc.traefik.io/traefik/) · [Nixpacks](https://nixpacks.com/docs) · [dockerode](https://github.com/apocas/dockerode)
- [TanStack Router](https://tanstack.com/router) / [Query](https://tanstack.com/query)
- [Coolify](https://github.com/coollabsio/coolify) and [Dokploy](https://github.com/Dokploy/dokploy) — worth reading for inspiration
