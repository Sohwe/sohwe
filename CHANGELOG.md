# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

- **Documentation** — `sohwe-getting-started.md`: **Browse files** is Phase 1 / v0.1.0; Phase 3 is volumes, encrypted env, and resource limits only (no duplicate “file browser in Phase 3”). See also `README.md` and `sohwe-prd.md` §10.3 for v0.1.0 UX notes.
- **Deployments** — Table per app (Vercel-style): short deployment id, **Current** on the active successful build, status + duration, branch, short **git SHA** + **commit subject** (one line, truncated), relative time, **Log** and per-row **Roll back** to any older successful build.
- **Schema** — `Deployment.commitMessage` (text), set at build time with `git log -1 --pretty=format:%s` (capped at 2k chars). Rollback/promote copies `commitMessage` and `commitSha` from the source deployment.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
