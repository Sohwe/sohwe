# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository.

## Project Overview

Sohwe is an open-source, self-hostable deployment platform/PaaS. Users create apps from Git repositories, build them with Dockerfile or Nixpacks, run them as Docker containers, route traffic through Traefik, and manage deployments, env vars, volumes, files, logs, metrics, and config backups from a React dashboard.

Source of truth for product direction and architecture:

- `README.md` - current status, install/development workflow, repo map
- `ROADMAP.md` - phase-by-phase checklist with per-item code evidence (authoritative on what is implemented)
- `DEVELOPMENT.md` - local env setup and dev deploy notes
- `sohwe-getting-started.md` - architecture, decisions, and design sketches for unbuilt phases
- `sohwe-prd.md` - product requirements
- `CHANGELOG.md` - released and unreleased behavior changes
- `docs/vps-smoke-test.md` - manual VPS verification steps
- `LICENSE` - AGPL-3.0

`apps/dashboard/README.md` is still the default Vite template; ignore it.

Milestone state (verify against `ROADMAP.md` before relying on this):

- `v0.3.8` is the latest tagged release; the `Unreleased` section of `CHANGELOG.md` is large.
- Phases 0-3.5 complete: deploys, Nixpacks, custom domains/HTTPS, encrypted env vars, volumes, resource limits, per-app networks, production packaging + installer + `sohwe` CLI.
- Phase 4 (observability) complete: runtime log SSE, live Docker stats, crash/OOM alerts.
- Phase 4.5 (portable bundles) complete: signed passphrase-protected config bundles, local/S3/download destinations, restore preflight+apply, scheduled exports with retention.
- Phase 5 (git-push deploys) complete: per-instance GitHub App via manifest flow, installation-token clones, signature-verified push webhook, auto-deploy toggle, commit statuses. A manual end-to-end check on a real host is still open.
- Phase 6 (multi-user) complete: owner/admin/member role guards, copy-link invitations, member management, org-scoped audit log, and the optional instance *host* filesystem browser (allowlist-gated via `SOHWE_HOST_FS_ALLOWLIST`, off by default, audited per list/read).
- Phase 7 (managed datastores) complete: host Postgres/Redis provisioned over a `datastore` queue, encrypted generated credentials, private app bindings, opt-in public host ports, password rotation, and datastore config in bundles.
- Phase 8 (custom domains) complete: a per-app **Domains** tab backed by a `Domain` table (many hostnames per app, one primary, unique instance-wide), hostname normalization and validation, per-domain DNS verification with cached status, NS-based provider detection with console deep links, and one-click A-record apply for Cloudflare, DigitalOcean, and Hetzner. A manual check against a real domain on a real host is still open.
- No milestone after Phase 8 is started; Domain Connect and further DNS provider drivers are the named follow-ups.

## Repository Shape

pnpm 9 + Turborepo monorepo. Node.js 24+ required.

- `apps/api` - Fastify API: auth/session, setup gate, application CRUD, deploy enqueue, SSE build + runtime logs, stats, alert destinations, container file browsing, backups, GitHub App connection + push webhook
- `apps/dashboard` - Vite + React SPA: TanStack Router/Query, Tailwind, Radix/shadcn-style UI, lucide icons, sonner
- `apps/worker` - BullMQ consumer: clones repos, builds images, runs containers, applies Traefik labels, injects decrypted env, manages volumes/networks, streams logs, samples stats, watches crash events, runs the backup scheduler (`apps/worker/src/backups.ts`)
- `packages/db` - Prisma schema and client
- `packages/types` - shared Zod schemas, inferred types, Docker resource naming helpers
- `packages/queue` - BullMQ queue/job helpers, Redis config, channel/key name helpers
- `packages/builder` - Dockerfile/Nixpacks image build wrapper
- `packages/crypto` - AES-256-GCM helpers for encrypted env vars
- `packages/bundler` - builds/parses signed, passphrase-encrypted `.sohwe.json` config bundles
- `packages/backups` - backup export orchestration and storage drivers (local filesystem + S3-compatible)
- `packages/github` - GitHub App client: manifest flow, installation tokens, webhook signature verification, commit statuses. Core (`src/index.ts`) is dependency-free and unit-tested; db-aware helpers live in the `./resolve` entry point
- `docker/` - production Dockerfiles and dashboard nginx config
- `docker-compose.dev.yml` - local Postgres, Redis, Traefik
- `docker-compose.prod.yml` + `docker-compose.https.yml` - production stack
- `scripts/install.sh`, `scripts/sohwe` - production installer and host CLI

## Commands

Run pnpm from the repo root unless a narrower filter is useful. On Windows PowerShell, use `pnpm.cmd` if `pnpm.ps1` is blocked by execution policy.

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d
pnpm db:generate
pnpm db:push
pnpm dev
```

`node scripts/dev-setup.mjs` (aka `pnpm run setup`) automates the sequence above for a fresh machine — prereq checks, install, env file generation, dev infra, migrations. Idempotent; never overwrites configured env values.

Validation: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` — all cover every workspace package (`test` runs only where a `test` script exists).
Database: `pnpm db:generate`, `pnpm db:push`, `pnpm db:studio`

ESLint uses flat config. The root `eslint.config.mjs` covers `apps/api`, `apps/worker`, and all of `packages/` (Node globals, no React); ESLint finds it by walking up from each package, so a new package needs only `"lint": "eslint ."` and no config of its own. `apps/dashboard` keeps its own `eslint.config.js` (browser globals + React plugins), which wins for that directory.

**CI:** `.github/workflows/ci.yml` runs on every push to `main` and every pull request. Three jobs: `verify` (typecheck + lint + build + test across all workspaces, with Postgres and Redis service containers for the API route tests), `migrations` (replays the committed Prisma migrations against a real Postgres 16 on both the fresh-install and the pre-v0.3.8 upgrade path, asserting no drift and no data loss), and `scripts` (shellcheck + bash syntax + an LF-ending guard for the installer and host CLI). `.github/workflows/release.yml` is separate and only builds/publishes images on `v*` tags.

**Tests:** unit tests use Node's built-in runner (`node:test`) executed through `tsx`; a package opts in with a `test` script listing its test files explicitly, and `turbo run test` picks it up. Every workspace package now has tests. Test files live under `src/`, so they are also typechecked by `build`/`typecheck` — keep them strict-clean (`noUncheckedIndexedAccess`). Add tests as `src/**/*.test.ts` in the relevant package and add the file to that package's `test` script; no new config is needed.

`apps/api/src/routes.test.ts` drives real HTTP through `app.inject()` (via `buildServer` in `apps/api/src/server.ts`, which assembles the Fastify instance without binding a port). It needs a **throwaway** Postgres named by `TEST_DATABASE_URL` — it truncates every table between tests and deliberately will not fall back to `DATABASE_URL`. Without that variable the suite skips itself, so `pnpm test` still works with no Docker. CI's `verify` job supplies Postgres and Redis service containers. Any new env var the tests need must be added to `passThroughEnv` for the `test` task in `turbo.json`, or turbo will not forward it.

## Environment

Local infrastructure: Postgres 16, Redis 7, Traefik v3 from `docker-compose.dev.yml`.

Env files (examples tracked as `.env.example` alongside each):

- `apps/api/.env` - `DATABASE_URL`, `REDIS_URL`, `PORT`, `SESSION_SECRET`, `SOHWE_ENCRYPTION_KEY`, `SOHWE_BASE_DOMAIN`, `SOHWE_HTTPS_ENABLED`, `SOHWE_CERT_RESOLVER`
- `packages/db/.env` - Prisma CLI `DATABASE_URL`

The worker loads env from several locations including `apps/api/.env`, so local dev usually shares the API's database, Redis, and encryption key. `SOHWE_ENCRYPTION_KEY` **must** match between API and worker or deploys cannot decrypt env vars.

Never commit real secrets or generated env files.

## Local Deployment Notes

- The worker must be running for queued deploy jobs to leave `pending`.
- Apps without a root `Dockerfile` use Nixpacks in `auto` mode.
- Local Nixpacks builds require a `nixpacks` executable. On Windows the builder falls back to `%USERPROFILE%\.nixpacks\bin\nixpacks.exe` when `nixpacks` is not on `PATH`.
- Production worker images bake in `git`, the Docker CLI, and Nixpacks; local dev uses host tools.

## Implementation Rules

### Shared Contracts

- Validation schemas that cross the API/dashboard boundary go in `packages/types/src/index.ts`.
- Prefer Zod schemas from `@sohwe/types` in Fastify route schemas, and parse bodies with the same schema when needed.
- Import across workspaces by package name: `@sohwe/types`, `@sohwe/db`, `@sohwe/queue`, `@sohwe/crypto`, `@sohwe/builder`, `@sohwe/bundler`, `@sohwe/backups`.
- Keep TypeScript strictness intact. `tsconfig.base.json` enables `strict`, `isolatedModules`, and `noUncheckedIndexedAccess`.

### API

- `apps/api/src/index.ts` is the process entrypoint only (env load, `listen`, boot tasks, SIGTERM). The Fastify instance is assembled by `buildServer` in `apps/api/src/server.ts` — put new routes and plugins there, so the server stays constructible without binding a port. Routes are registered via `register*Routes` functions; modules live in `apps/api/src/routes` (`applications`, `env-vars`, `build-args`, `variables`, `volumes`, `domains`, `dns`, `alert-destinations`, `app-filesystem`, `host-fs`, `backups`, `datastores`, `github`, `github-webhook`, `members`, `audit`).
- Protected routes use `requireRole(min)` from `apps/api/src/rbac.ts` (see *Roles, Invitations, and the Audit Log*) and scope every query by `req.user!.organizationId`. Backups routes are org-scoped, not app-scoped. `authPreHandler` in `apps/api/src/session.ts` is the underlying auth step and is fine on its own only for routes with no role floor at all.
- Redis handles owned by a route module (the deploy queue, the stats client) are created inside `register*Routes` and closed in that instance's `onClose` — never at module load. A module-level connection is shared by every server built in the process, so one `app.close()` breaks the rest, which the route tests hit immediately.
- Never return `Application.envVarsEncrypted` or `Application.buildArgsEncrypted` from general endpoints. Use `defaultApplicationSelect` and `serializeAppListRow` from `apps/api/src/app-public.ts` unless a route deliberately deals in secrets.
- Mutating env and build-arg routes must not log request bodies. Preserve the existing `logLevel: "silent"` pattern when editing them.
- Applications carry two independent variable maps — runtime env vars (`/env`) and build variables (`/build-args`) — presented to the dashboard as **one scoped list** by `/api/applications/:id/variables` (`apps/api/src/routes/variables.ts`). A variable's scope (`runtime` / `build` / `both`) is *derived* from which maps hold the key; it is never stored, so there is no third source of truth. Shared shaping/merging logic lives in `apps/api/src/routes/variable-store.ts` — put changes there rather than in one route module, or the surfaces drift. The two per-map routes stay because datastore bindings and bundle restore write one map without touching the other.
- Custom domains are a **list**, owned by the `Domain` table — there is no `applications.domain` column. Hostnames are unique instance-wide (Traefik routes by host across the whole instance, so a shared hostname cross-routes traffic), one domain per app is `isPrimary`, and the `domain` field on an application row is a *projection* of that primary computed in `serializeAppListRow`, not a second store. Domain changes go through `apps/api/src/routes/domains.ts`; `PATCH /api/applications/:id` does not touch domains.
- DNS provider integrations implement the `DnsDriver` contract in `apps/api/src/dns/driver.ts` and register in `drivers.ts`. Two rules hold for every driver: the API token goes in a request header and nowhere else — never into a thrown message, which surfaces in responses and logs — and an existing CNAME on the target name is a refusal, not an overwrite. Which driver runs is decided by the domain's detected nameservers, not by which credentials happen to be stored. Adding a provider is a driver, a registry entry, an id in `DNS_API_PROVIDERS`, and `apiSupported: true` on its `providers.ts` entry.
- Serialize BigInt values (e.g. volume `sizeBytes`) before JSON responses.
- SSE build logs use Redis pub/sub plus stored `Deployment.buildLogs`; preserve replay-on-reconnect. Runtime log SSE (`GET /api/applications/:id/logs`) replays recent Docker logs then follows the Redis channel. The stored copy is capped and may be truncated (see `apps/worker/src/build-log.ts`) — do not assume it holds the whole build.
- `GET /api/config` is public and allowed through the setup gate (`apps/api/src/setup-gate.ts`); it exists so the dashboard learns `SOHWE_BASE_DOMAIN` at runtime instead of baking it into the image.
- Environment is validated at boot in `apps/api/src/env.ts` (`loadApiConfig`) and the API exits fast on a bad config. Read config from the returned `ApiConfig` (e.g. `config.corsOrigin`, `config.port`, `config.sessionSecret`) rather than re-reading `process.env` in `index.ts`. The worker has a matching boot check in `apps/worker/src/index.ts`.
- The two unauthenticated credential endpoints (`/api/auth/login`, `/api/setup/unlock`) carry an opt-in per-route rate limit via `config: AUTH_RATE_LIMIT` (`@fastify/rate-limit` is registered with `global: false`). Keep new pre-auth endpoints rate-limited, and do not enable a global limit — it would throttle metrics polling and log SSE. The app runs with `trustProxy` so limits key off the forwarded client IP.
- The setup-gate cookie is HMAC-signed with an issue timestamp and expires server-side after 7 days (`apps/api/src/setup-gate.ts`); keep the `t` check when touching that file.

### Worker and Docker

- The worker is the only service that executes deploys: git clone, image build, container create/start, volume creation, per-app network creation, and deployment status transitions.
- Build mode semantics live in `packages/builder`: `auto` prefers a Dockerfile and falls back to Nixpacks; `dockerfile` requires a root Dockerfile; `nixpacks` always uses Nixpacks.
- `packages/builder/src/node-version.ts` supplies `NIXPACKS_NODE_VERSION` for Nixpacks builds when the repo pins nothing, because Nixpacks' own fallback is the end-of-life Node 18. Keep it subordinate to every explicit pin (`NIXPACKS_NODE_VERSION`, `engines.node`, `.nvmrc`, `.node-version`), keep it off Dockerfile builds, and keep `DEFAULT_NODE_VERSION` inside Nixpacks' `AVAILABLE_NODE_VERSIONS` — an unsupported value silently falls back to 18 and defeats the purpose.
- Preserve Docker naming helpers from `@sohwe/types`:
  - volumes: `sohwe_app_<appId>_<volumeId>`
  - internal networks: `sohwe_app_<appId>_net`
- Keep Sohwe labels on managed resources: `sohwe.managed`, `sohwe.app`, `sohwe.volume`, `sohwe.deployment`.
- An app answers on its generated `<slug>.<base-domain>` host *plus every row in its `domains` relation*; `resolveHosts` builds that list (primary first, deduplicated) and each entry becomes a `Host()` term on one Traefik router. Deploys are what apply a domain change — the running container keeps its labels until then.
- Routing decisions and the `docker.createContainer` argument live in `apps/worker/src/container-spec.ts` — Traefik labels, TLS opt-in, mounts, and resource limits. Keep that module pure (no I/O, no `process.env` reads) so it stays testable; the caller resolves the environment via `resolveRoutingConfig`. Traefik router names carry a digest of the full slug because sanitizing is lossy and two apps sharing a router name cross-route traffic.
- Containers attach to the Traefik network *and* a per-app internal bridge network. Do not drop that isolation.
- Log/stat channel and key names come from `@sohwe/queue` (`appLogChannelName`, `appStatsKey`); do not hand-build these strings.
- The worker's Docker subsystems are extracted modules that take a narrow structural slice of dockerode so they stay testable against doubles: `runtime-logs.ts` (log tailing), `stats.ts` (sampling), `crash-watch.ts` (event classification + reconnecting watcher), `docker-ops.ts` (deploy-path container/volume/network ops). `index.ts` only wires them to the real daemon, Redis, and Prisma — put new Docker behavior in a module of this shape, not inline in the entrypoint.
- Stats snapshots in Redis are short-TTL; a missing sample means "not running", not an error.
- The worker re-attaches log streams and stat sampling for already-running managed containers on startup - preserve that recovery path.
- Env vars are encrypted at rest and decrypted only for Docker `Env` injection. Never write plaintext env values to build logs, runtime logs, alert payloads, API responses, or error messages.
- The build map (`buildArgsEncrypted`) is the *only* thing that reaches the image build; the runtime map is injected long after the image exists. A variable scoped `both` in the UI is simply the same key in both maps — the worker knows nothing about scopes. `packages/builder` owns argv construction (`nixpacksArgv`, `dockerBuildArgv` — keep both pure and tested) and scrubs build variable values out of forwarded tool output via `redactValues`. Docker gets the name-only `--build-arg KEY` form so values stay off the argv; nixpacks has no such form and needs `KEY=value`. Build logs may name the keys, never the values.
- Custom domain/HTTPS behavior is driven by `SOHWE_HTTPS_ENABLED`, `SOHWE_CERT_RESOLVER`, `SOHWE_BASE_DOMAIN`, `TRAEFIK_DOCKER_NETWORK`.

### Backups and Bundles

- Bundles are **config-only**: app settings, custom domains, volume *definitions* (mount paths, not data), alert destinations, and optionally re-encrypted env vars and build variables. No git mirrors, no volume data. Do not quietly widen this scope.
- `packages/bundler` derives a key from the user passphrase via scrypt, AES-256-GCM-encrypts env vars, and HMAC-SHA256-signs the manifest. Any change to bundle layout is a compatibility break - version it and note it in `CHANGELOG.md`. A frozen **golden bundle** in `packages/bundler/src/index.test.ts` must keep parsing; if that test fails you have changed the on-disk format (KDF params, `canonicalize`, ciphertext layout, or schema) — bump `BUNDLE_VERSION` and add a migration path rather than editing the golden.
- Restore is non-destructive by default: restored apps land in `idle` so nothing deploys and no ACME certs are requested until the user acts. Slug collisions are resolved by an explicit `rename` / `overwrite` / `skip` policy chosen after preflight.
- Preflight summaries report env var *key counts*, never values.
- Scheduled exports run on a BullMQ tick job owned by the worker (`apps/worker/src/backups.ts`); use the `BACKUP_*` constants from `@sohwe/queue`.
- Storage drivers live in `packages/backups/src/storage.ts` (local path and S3-compatible). S3 credentials are stored encrypted - resolve destinations through the existing helper rather than reading config rows directly.

### GitHub and Push Deploys

- Sohwe never ships a central GitHub App. Each instance creates its own via GitHub's manifest flow; credentials (`pem`, `webhookSecret`, `clientSecret`) are encrypted with `SOHWE_ENCRYPTION_KEY` in `GitHubApp.credentialsEncrypted` and must never be returned by any endpoint.
- The webhook route needs the **raw** request body for `X-Hub-Signature-256`. It lives in an encapsulated Fastify scope with its own buffer content-type parser — do not move it to the root instance or re-serialize the payload.
- Nothing in a webhook payload may be trusted before the HMAC verifies. Which app signed a delivery is unknowable beforehand, so each connected app's secret is tried.
- Installation tokens are secrets. Never log a tokenized clone URL; run anything derived from a failed clone through `redactSecret` / `redactDeployError` first. Git echoes the remote in its error output.
- Commit-status reporting is best-effort and must swallow its own failures — it can never fail a deploy.
- Every delivery is recorded through `recordWebhookDelivery` (`apps/api/src/webhook-deliveries.ts`), including rejected ones — a wrong webhook secret is the most common cause of a silent missed push. Recording is best-effort and must never fail a delivery that would otherwise deploy. Rejected rows may only carry GitHub's clear-text headers; repo/branch/commit are populated after the HMAC verifies.
- `SOHWE_PUBLIC_URL` is fixed into the App's webhook/redirect URLs at creation time. Changing it later requires recreating the App on GitHub.

### Roles, Invitations, and the Audit Log

- Roles are strictly ordered: `owner` > `admin` > `member`. Guard routes with `requireRole(min)` from `apps/api/src/rbac.ts`, not bare `authPreHandler` — it authenticates first, so `preHandler: [requireRole("member")]` is complete on its own. Unknown role strings rank 0 and get nothing; keep that fail-closed behavior.
- The dividing line for a new route is **can this surface expose a secret**, not read-vs-write. Env vars (including the masked listing), the container file browser, alert destinations, backups, and the GitHub connection are admin-and-above even for reads. `member` covers viewing apps plus deploy/rollback.
- Role changes must stay effective without re-login; the role is read from the DB on every request via the session lookup. Do not cache it into the session row.
- Invariants enforced in `apps/api/src/routes/members.ts`: the org can never lose its last owner, nobody changes their own role or removes their own account, and an admin cannot remove an owner. Keep these when touching that file.
- Invitations are copy-link, never email. Only `tokenHash` (SHA-256) is stored; the raw token appears exactly once, in the create response. Never add an endpoint that re-reveals a token, and never log one. Acceptance claims the row with a conditional `updateMany` inside the user-creating transaction — keep that, or one link can mint two accounts.
- Record mutating actions with `recordAudit` from `apps/api/src/audit.ts`, and add the action to the `AuditAction` union and `AUDIT_ACTIONS`. Audit writes are best-effort and must never fail the request they describe.
- **Nothing secret goes in an audit row.** Env events carry key names and counts (`envChangeMetadata`), never values; backup events never carry passphrases or S3 credentials; GitHub events never carry the PEM or webhook secret; invitation events never carry the token. `actorEmail` is denormalized on purpose so removing a user does not erase their trail.

### Database

- Schema is `packages/db/prisma/schema.prisma`. Migrations are versioned SQL in `packages/db/prisma/migrations`.
- **Every schema change must ship as a migration.** Run `pnpm db:migrate --name <short_description>` (`prisma migrate dev`), then commit the generated `migration.sql`. `sohwe migrate` (and therefore `sohwe update`) runs `prisma migrate deploy`, which replays exactly that file on production.
- Do not use `pnpm db:push` for anything that will be committed — it mutates the DB without recording a migration and drifts the dev database from what production replays. Scratch databases only.
- Read the generated SQL before committing. Prisma emits `DROP COLUMN` and type narrowing without warning, there are no down-migrations, and `sohwe rollback` restores images but not schema. Flag any destructive migration in `CHANGELOG.md`.
- Never renumber or edit `20260722000000_init`. It reproduces the schema every release through v0.3.8 shipped, and `cmd_migrate` in `scripts/sohwe` baselines pre-migration databases against that exact directory name when `prisma migrate deploy` reports `P3005`.
- Never edit a migration that has already been released — add a new one.
- After schema changes run `pnpm db:generate` and at least `pnpm typecheck`.
- Be careful with destructive schema/data changes - this is a deployment platform and user app configuration is stateful.

### Dashboard

- Routes are composed manually in `apps/dashboard/src/router.tsx`; route components live in `apps/dashboard/src/routes`.
- Use the `@` alias for dashboard source imports.
- API helpers live in `apps/dashboard/src/lib/api.ts`; keep `credentials: "include"` for cookie auth.
- Read the apps base domain via `lib/config.ts#useBaseDomain` (TanStack Query, `staleTime: Infinity`). Do not reintroduce a hardcoded base domain constant.
- In dev, Vite proxies `/api` to `http://127.0.0.1:3001`. Production images serve same-origin `/api` through nginx, so avoid CORS-dependent frontend behavior.
- Reuse primitives in `apps/dashboard/src/components/ui` and the `common`/`layout` components before adding new ones.
- Use lucide icons for icon buttons.
- Keep the UI dense and operational. Sohwe is a control plane, not a marketing site.

### Installer and Production Files

- `scripts/install.sh`, `scripts/sohwe`, production compose files, and Dockerfiles are user-facing product surface. Update `README.md` and `CHANGELOG.md` when their behavior changes.
- The installer targets fresh Ubuntu 22.04/24.04/26.04 hosts (other Ubuntu releases warn and continue) and writes state under `/etc/sohwe/`.
- Any new API or worker env var must be threaded through `scripts/install.sh` (into `/etc/sohwe/sohwe.env`) *and* the shared env block in `docker-compose.prod.yml`, or it will silently fall back to a default in production.
- Production images publish to GHCR from `.github/workflows/release.yml` on `v*` tags.

## Documentation Expectations

Update docs when behavior changes:

- `README.md` - install/dev commands, env vars, current status, repo layout
- `ROADMAP.md` - check off completed items and keep the evidence file lists accurate
- `DEVELOPMENT.md` - local setup prerequisites and dev-only gotchas
- `sohwe-getting-started.md` - architecture, phase scope, implementation flow
- `sohwe-prd.md` - product requirements
- `CHANGELOG.md` - notable fixes, additions, and breaking changes, under `Unreleased` until tagged

All docs were reconciled against the code on 2026-07-22. `ROADMAP.md` is the authoritative phase-status source; if another doc disagrees with it, the other doc is wrong.

`sohwe-getting-started.md` is an architecture reference, not a tutorial. Its completed-phase build walkthroughs were deliberately removed (recoverable from git history) - do not reintroduce step-by-step setup prose there. Its Phase 5/6/7 sections are unbuilt design sketches; when a phase ships, replace the sketch with an "As Built" summary rather than leaving the sketch to drift.

## Verification Checklist

Before handing off a change, run the narrowest meaningful checks:

- Type/schema/shared logic: `pnpm typecheck`
- Dashboard UI: `pnpm --filter @sohwe/dashboard lint` and `pnpm --filter @sohwe/dashboard build`
- API/worker/shared packages: `pnpm build`, or the affected package's `build` script
- Prisma schema: `pnpm db:generate` and `pnpm --filter @sohwe/db typecheck`
- Installer/compose/Docker: inspect the relevant compose/Dockerfile paths and update docs + changelog

If a check cannot run because Docker, env files, the database, or network access is unavailable, say so plainly in the final response rather than implying it passed.
