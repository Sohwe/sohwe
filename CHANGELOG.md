# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
