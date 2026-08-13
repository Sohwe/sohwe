# Sohwe

Sohwe is an open-source, self-hostable deployment platform (PaaS): connect a repo, deploy to your own infrastructure, and get live URLs with HTTPS, logs, and sensible defaults—without vendor lock-in. The product vision and roadmap live in [`sohwe-prd.md`](./sohwe-prd.md).

This repository is a **pnpm + Turborepo** monorepo. The detailed bootstrap and phased implementation guide is [`sohwe-getting-started.md`](./sohwe-getting-started.md).

## Current status

**v0.3.8** is the latest tagged release. Everything below Phase 4 is in it; Phases 4, 4.5, and 5 are complete on `main` and staged as **v0.6.0**, pending a manual verification pass on a real host.

Shipped through **Phase 5**:

- **Phases 0–3** — deploys from Git, Dockerfile + Nixpacks builds, custom domains with opt-in HTTPS, encrypted env vars, named persistent volumes, memory/CPU limits, per-app internal Docker networks.
- **Phase 3.5 (packaging & install)** — production Dockerfiles, `docker-compose.prod.yml` + HTTPS overlay, multi-arch GHCR publishing on tag, and a one-command installer for fresh Ubuntu 22.04/24.04 hosts.
- **Phase 4 (observability)** — runtime log streaming, live CPU/memory metrics, and crash/OOM webhook alerts.
- **Phase 4.5 (portable bundles)** — signed, passphrase-encrypted config bundles with local and S3-compatible destinations, restore preflight/apply, and scheduled exports with retention.
- **Phase 5 (git-push deploys)** — per-instance GitHub App created through GitHub's manifest flow, private-repo cloning with short-lived installation tokens, a signed push webhook that deploys the tracked branch, and commit statuses reported back to GitHub.
- **Phase 6 (multi-user)** — owner/admin/member roles enforced on every route, copy-link invitations, member management, and an org-scoped audit log. On `main` for **v0.7.0**.
- **Phase 7 (managed datastores)** — one-click Postgres/Redis on the host with encrypted generated credentials, private app bindings that inject `DATABASE_URL`/`REDIS_URL` into encrypted env vars, opt-in public host ports, and password rotation. On `main` for **v0.8.0**.

[`ROADMAP.md`](./ROADMAP.md) is the authoritative per-item checklist; see also [`CHANGELOG.md`](./CHANGELOG.md).

## Install on a server (production)

On a fresh Ubuntu 22.04 or 24.04 host:

```bash
curl -fsSL https://raw.githubusercontent.com/Sohwe/sohwe/main/scripts/install.sh | bash
```

The installer will:

1. Install Docker Engine + the compose plugin if they aren't already present.
2. Prompt for an **HTTP port** for the dashboard (default **8080**) and verify it is free on the host.
3. Optionally prompt for a **public domain** and Let's Encrypt email — skip to use `http://<server-ip>:<port>` only.
4. Prompt for an **apps base domain** (`SOHWE_BASE_DOMAIN`) — the wildcard parent for deployed app URLs, e.g. `apps.example.com` gives you `myapp.apps.example.com`. Defaults to the dashboard host, falling back to `sohwe.localhost`. Point a wildcard DNS record (`*.apps.example.com A <ip>`) at the box for this to resolve.
5. Prompt for an **installer password** (confirmed twice); this unlocks the dashboard for first-run setup before anyone can create the owner account.
6. Generate `/etc/sohwe/sohwe.env` with random `SESSION_SECRET`, `SOHWE_ENCRYPTION_KEY`, Postgres password, and your chosen values (mode 0600).
7. Pull the `api`, `worker`, and `dashboard` images from GHCR and start the stack.
8. Apply the database schema via the running API container.
9. Print the dashboard URL(s).

Unlock first-run setup with your installer password, then complete setup (owner account + organization) in the dashboard.

Non-interactive installs can pass **`SOHWE_HTTP_PORT`**, **`SOHWE_SETUP_PASSWORD`**, **`SOHWE_BASE_DOMAIN`**, **`SOHWE_HOST`**, **`SOHWE_ACME_EMAIL`**, **`SOHWE_PUBLIC_URL`**, and **`SOHWE_VERSION`** via the environment, with `SOHWE_NONINTERACTIVE=1` (see the header comments in `scripts/install.sh`).

### Deploy on git push

Open **Git** in the dashboard and create a GitHub App. Sohwe never ships a central app: GitHub's manifest flow creates one that belongs to you, and this instance stores its private key and webhook secret encrypted with `SOHWE_ENCRYPTION_KEY`. Install the app, pick which repositories to share, then turn on **Push to deploy** on any app (or tick it when creating one).

The app requests the minimum: read repository contents and metadata, write commit statuses, and the `push` event only. Private repositories clone with a short-lived installation token, and each deploy reports pending/success/failure back to the commit.

**Set `SOHWE_PUBLIC_URL` in `/etc/sohwe/sohwe.env` before connecting.** It becomes the app's webhook and redirect URL at creation time, so a wrong value means deleting the app on GitHub and starting over. The installer derives it from your dashboard domain; HTTP-only installs must set it by hand (`http://<server-ip>:<port>`) and `sohwe restart`.

> **Schema updates are versioned migrations.** `sohwe migrate` — which `sohwe update` runs for you — executes `prisma migrate deploy` inside the api container, replaying the reviewed SQL in `packages/db/prisma/migrations`. A database created by **v0.3.8 or earlier** predates the migrations directory; the first `sohwe migrate` after upgrading detects it and baselines it automatically (a history-only record — no DDL, no data loss). Migrations are forward-only, so `sohwe rollback` does not revert a schema change; back up before a release whose changelog flags a destructive migration.

### Invite your team

Open **Members** in the dashboard and create an invitation. Sohwe does not send
email — it mints a single-use join link that you pass on however you like, which
keeps a self-hosted instance free of an SMTP relay or a third-party email key.
The link is shown **once**: only its SHA-256 is stored, so a lost link is
revoked and reissued rather than recovered. Links expire after 7 days.

Three roles, enforced by the API on every request:

| Role | Can do |
| --- | --- |
| `owner` | Everything, including changing roles and managing other owners. |
| `admin` | Everything operational: apps, env vars, volumes, backups, Git, invitations, removing members. |
| `member` | Read-only, plus deploying and rolling back existing apps. |

Anything that can expose an app's secrets is admin-and-above **including read
access**: environment variables (even the masked list), the container file
browser, alert destination webhook URLs, backups, and the GitHub connection.

The organization can never be left without an owner, nobody can change their own
role or delete their own account, and removing someone signs out every session
they hold. Every mutating action lands in the **Audit log** — with env var *key
names* and counts, never values.

### Managed datastores

Open **Datastores** to create a managed Postgres 16/17 or Redis 7 instance on
the same host — an official image with a persistent volume, generated
credentials encrypted at rest, and no exposure beyond the apps you bind it to.
Binding injects the connection URL (`DATABASE_URL` / `REDIS_URL`, or a custom
key) into the app's encrypted env vars and attaches the datastore to the app's
private Docker network; the app picks it up on its next deploy. Deleting a
datastore destroys its volume and data, and says so before doing it.

Need to reach a datastore from your laptop or an app hosted elsewhere? Enable
**public access** on it: Sohwe publishes the service on a stable high port
(20000–29999) and the connection panel shows a public URL alongside the
internal one. This is plain TCP guarded only by the generated password —
Docker publishes the port past ufw-style host firewalls — so treat it as a
convenience to switch off when you are done. Password rotation updates every
bound app's injected URL (redeploy to apply) and invalidates old external
credentials immediately.

### Managing the instance

Everything is driven by the `sohwe` CLI installed to `/usr/local/bin/sohwe`:

```bash
sohwe status               # show running services
sohwe logs api             # tail a service's logs
sohwe update               # upgrade to latest
sohwe update v0.4.0        # pin a specific version
sohwe rollback             # revert to the version before the last update (one hop)
sohwe restart
sohwe migrate              # apply pending DB migrations
sohwe migrate-status       # show applied vs pending migrations
sohwe env                  # print the path to the env file
```

State lives entirely under `/etc/sohwe/`. Postgres data and Let's Encrypt certs are in named Docker volumes (`sohwe_postgres_data`, `sohwe_traefik_acme`), so re-running the installer or rebooting the host doesn't lose data.

## Development

### Requirements

- **Node.js** 24+ (see `.nvmrc`)
- **pnpm** 9 (`packageManager` in root `package.json`)
- **Docker** (for local Postgres, Redis, Traefik)

### Quick start

1. **Install dependencies**

   ```bash
   pnpm install
   ```

2. **Start infrastructure**

   ```bash
   docker compose -f docker-compose.dev.yml up -d
   ```

3. **Configure environment**

   Copy or create `.env` files where the apps expect them (see [Environment](#environment)). At minimum you need a valid `DATABASE_URL` pointing at the Compose Postgres database (`sohwe_dev` by default), plus `SESSION_SECRET` and `SOHWE_ENCRYPTION_KEY` for the API.

4. **Database**

   ```bash
   pnpm db:generate
   pnpm db:migrate:deploy
   ```

5. **Run apps**

   ```bash
   pnpm dev
   ```

   - Dashboard: [http://localhost:3000](http://localhost:3000)
   - API: [http://localhost:3001](http://localhost:3001) (e.g. `GET /health`)

   On first visit, complete setup to create the owner and organization, then sign in.

### Environment

- **`apps/api/.env`** — API runtime (`DATABASE_URL`, `REDIS_URL`, `PORT`, `SESSION_SECRET`, `SOHWE_ENCRYPTION_KEY`, etc.). The **worker** also needs `SOHWE_ENCRYPTION_KEY` (and `DATABASE_URL` / `REDIS_URL`) to decrypt env at deploy; in local dev, `apps/worker` loads `apps/api/.env` via dotenv, so a single file is enough.
- **`packages/db/.env`** — Prisma CLI (`DATABASE_URL` for `db:migrate` / `db:studio`).

Use strong, unique values for secrets in any shared or deployed environment. The API validates its environment at boot and refuses to start if `SESSION_SECRET` (min 16 chars) or `SOHWE_ENCRYPTION_KEY` (32 bytes, base64) is missing or malformed. `SOHWE_CORS_ORIGIN` is optional — leave it unset in production (the dashboard is same-origin through nginx). `SOHWE_PUBLIC_URL` is optional too, but GitHub push deploys need it: it becomes the GitHub App's webhook URL, so local development requires a tunnel (cloudflared, ngrok, tailscale funnel) pointed at the dashboard. `SOHWE_HOST_FS_ALLOWLIST` (optional, off by default) turns on the admin-only **Host files** browser for the listed absolute paths; every list/read is audited, and in production the API container can only reach paths mounted into it (`/etc/sohwe` is mounted read-only by default). The getting-started doc shows the expected variable names and example connection strings.

HTTPS for deployed apps is driven by two variables, both set in `/etc/sohwe/sohwe.env` on a production install:

| Variable | Default | Effect |
| --- | --- | --- |
| `SOHWE_HTTPS_ENABLED` | `false` (`true` when the installer was given a dashboard domain) | Opts deployed apps into TLS Traefik labels, and sets the `Secure` flag on auth cookies. Leave it `false` for HTTP-only installs, or browsers refuse to store the login cookie. |
| `SOHWE_CERT_RESOLVER` | `letsencrypt` | Name of the Traefik ACME resolver put on those TLS labels. The default matches the resolver `docker-compose.prod.yml` declares; change it only alongside a compose override that declares a resolver by the new name. |

Certificates are only requested for apps on a real public domain — Let's Encrypt will not issue for `.localhost` or `.local`, so those are skipped even when HTTPS is on.

### Repository layout

| Path | Role |
| --- | --- |
| `apps/api` | Fastify HTTP API |
| `apps/dashboard` | Vite + React control plane UI |
| `apps/worker` | BullMQ consumer: git clone, build, dockerode, Traefik labels, log/stats streaming, crash watcher, backup scheduler, datastore provisioning |
| `packages/db` | Prisma schema and client |
| `packages/types` | Shared Zod schemas, types, and Docker naming helpers |
| `packages/queue` | BullMQ job types, queue config, channel/key helpers (API + worker) |
| `packages/builder` | Dockerfile / Nixpacks image build wrapper |
| `packages/crypto` | AES-256-GCM env encryption helpers (API + worker) |
| `packages/bundler` | Signed, passphrase-encrypted config bundles |
| `packages/backups` | Backup destinations (local + S3) and export orchestration |
| `packages/github` | GitHub App client: manifest flow, installation tokens, webhook signatures, commit statuses |
| `docker-compose.dev.yml` | Local Postgres, Redis, Traefik |
| `docker-compose.prod.yml` + `docker-compose.https.yml` | Production stack (api + worker + dashboard + infra) |
| `docker/*.Dockerfile` | Multi-stage production images (api / worker / dashboard) |
| `scripts/install.sh` | One-command installer for Ubuntu 22.04/24.04 |
| `scripts/sohwe` | Host-side CLI installed to `/usr/local/bin/sohwe` |
| `.github/workflows/ci.yml` | Typecheck/lint/build, migration replay, and script checks on every push + PR |
| `.github/workflows/release.yml` | Multi-arch GHCR publish on `v*` tags |

### Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Run all packages’ `dev` tasks via Turborepo |
| `pnpm build` | Production build |
| `pnpm lint` | Lint |
| `pnpm typecheck` | Typecheck |
| `pnpm test` | Run unit tests (Node's test runner via tsx; `@sohwe/crypto`, `@sohwe/bundler`) |
| `pnpm db:generate` | `prisma generate` |
| `pnpm db:migrate` | Create + apply a migration for a schema change (dev) |
| `pnpm db:migrate:deploy` | Apply pending migrations without generating one |
| `pnpm db:migrate:status` | Show applied vs pending migrations |
| `pnpm db:push` | Push schema without a migration — scratch/throwaway DBs only |
| `pnpm db:studio` | Open Prisma Studio |

## Documentation

- [`CLAUDE.md`](./CLAUDE.md) — working rules and context for coding agents
- [`ROADMAP.md`](./ROADMAP.md) — per-phase checklist with file-level evidence
- [`DEVELOPMENT.md`](./DEVELOPMENT.md) — local environment setup and dev deploy notes
- [`sohwe-getting-started.md`](./sohwe-getting-started.md) — architecture, decisions, and unbuilt-phase design
- [`sohwe-prd.md`](./sohwe-prd.md) — product requirements and release plan
- [`docs/vps-smoke-test.md`](./docs/vps-smoke-test.md) — manual VPS verification checklist

## License

[AGPL-3.0](./LICENSE). You can run, modify, and redistribute Sohwe, but derivative hosted services must also open-source their changes.
