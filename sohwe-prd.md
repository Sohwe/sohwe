# Sohwe — Product Requirements Document

| | |
| --- | --- |
| **Product** | Sohwe |
| **Type** | Open-source, self-hostable deployment platform (PaaS) |
| **License** | AGPL-3.0 |
| **Status** | Draft — pre-v1 |
| **Owner** | — |
| **Last updated** | 2026-04-21 |
| **Companion docs** | `sohwe-getting-started.md` (architecture & implementation) |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Vision](#3-vision)
4. [Goals & Non-Goals](#4-goals--non-goals)
5. [Target Users & Personas](#5-target-users--personas)
6. [Competitive Landscape](#6-competitive-landscape)
7. [Positioning & Differentiation](#7-positioning--differentiation)
8. [Success Metrics](#8-success-metrics)
9. [User Stories](#9-user-stories)
10. [Functional Requirements](#10-functional-requirements)
11. [Non-Functional Requirements](#11-non-functional-requirements)
12. [Release Plan](#12-release-plan)
13. [Monetization Strategy](#13-monetization-strategy)
14. [Risks & Assumptions](#14-risks--assumptions)
15. [Open Questions](#15-open-questions)
16. [Glossary](#16-glossary)

---

## 1. Executive Summary

Sohwe is an open-source, self-hostable deployment platform that lets developers ship any application — Next.js, Node, Python, Go, Rust, static sites, or arbitrary Docker images — to their own servers with the same ergonomics as Vercel or Railway: connect a repo, push to deploy, get a live URL with automatic HTTPS, view logs and metrics.

It targets developers and small teams who want the Vercel experience without vendor lock-in, without per-seat pricing, and with full control over their data and infrastructure. Sohwe will be the easiest path from `git push` to a running container on a server you own.

Long term, the project will support a hosted commercial offering (managed Sohwe + enterprise features) on an open-core model, protected by the AGPL license.

---

## 2. Problem Statement

Developers and small teams face a binary choice today:

1. **Managed PaaS (Vercel, Railway, Render, Fly.io, Heroku)** — excellent DX, but costs scale aggressively with usage, hidden bandwidth/egress charges are common, data sovereignty is limited, and vendor lock-in is real.
2. **Bare-metal or cloud-VM self-hosting** — full control and dramatically lower cost, but the setup (Nginx/Caddy, CI pipelines, zero-downtime deploys, HTTPS, logs, alerts) takes days to weeks and ongoing maintenance is an invisible tax.

Existing self-hosted alternatives (Coolify, Dokploy, CapRover) have narrowed this gap but still have rough edges: inconsistent runtime support, opinionated build systems that fail on non-trivial projects, limited observability, brittle GitHub integrations, or clunky multi-tenant stories.

**Sohwe's opportunity** is to be the self-hosted PaaS that actually matches the ergonomics of Vercel, not just the feature checklist.

---

## 3. Vision

> A developer with a $5/month VPS should be able to ship their next idea as confidently as someone on Vercel — in under 10 minutes, with every modern runtime supported out of the box, and zero Linux sysadmin work.

Three years from now, Sohwe is:

- The default recommendation when someone on Hacker News / Reddit asks "how do I deploy my side project cheaply."
- Installed on 50k+ servers.
- Backed by a small hosted-SaaS business for teams that don't want to self-host.

---

## 4. Goals & Non-Goals

### 4.1 Goals (v1)

1. **10-minute install** — a single command on a fresh Ubuntu VPS results in a working Sohwe instance with HTTPS.
2. **Zero-config builds for the top runtimes** — Next.js, Node, Python, Go, Rust, and static sites deploy with no user-written Dockerfile.
3. **Git-push deploys** — pushing to a tracked branch triggers an automatic deploy with no additional tooling.
4. **Production-grade defaults** — HTTPS, restart-on-crash, resource limits, encrypted secrets, persistent volumes.
5. **Live observability** — streaming build and runtime logs, per-container CPU/memory, crash alerts.
6. **Owner + invited members** — initial single-owner setup with the path to multi-user clearly built into the schema.
7. **Open-source and trustable** — AGPL-3.0, transparent development, documented architecture, reproducible installs.

### 4.2 Non-Goals (v1)

- **Kubernetes orchestration** — Sohwe runs on Docker Engine only.
- **Multi-node clustering** — single-server deployment in v1. Multi-node is a v2 goal.
- **Databases-as-a-service** — users bring their own DB in v1. One-click Postgres/Redis ships in v2.
- **Preview deployments per pull request** — deferred to v2.
- **Built-in CI** — no custom pipelines; we consume the output of a Git push.
- **Marketplace / app templates** — deferred.
- **Hosted-only features** — every v1 feature is available in the OSS distribution.

---

## 5. Target Users & Personas

### 5.1 Primary: The Indie Hacker

- Builds multiple side projects on one or two VPS instances.
- Values cost efficiency (runs on a $6/mo Hetzner box, not $50/mo on Vercel Pro).
- Knows Docker conceptually but doesn't want to hand-write Dockerfiles for every project.
- Cares about: deploy speed, cost, custom domains, "just works" HTTPS.
- Pain today: stringing together Caddy, GitHub Actions, Docker Compose for each project.

### 5.2 Secondary: The Small Startup CTO / Tech Lead

- 2–10 engineers, shipping a product.
- Wants Heroku-style DX but on their own AWS/GCP/Hetzner account for cost and compliance reasons.
- Needs: multi-user access, audit trail, reliable deploys, observability.
- Pain today: either paying $2k+/mo for managed PaaS or building a bespoke deploy pipeline internally.

### 5.3 Tertiary: The Homelab Enthusiast

- Runs a home server or small cluster for self-hosted services.
- Wants a unified control plane instead of hand-written `docker-compose.yml` files.
- Pain today: every service has its own deploy dance.

### 5.4 Out of scope (for v1 messaging)

- Large enterprises with strict compliance (SOC 2, HIPAA) — addressable post-v1 with an enterprise tier.
- Teams deploying to Kubernetes clusters — different product category.

---

## 6. Competitive Landscape

| Product | License | Model | Strengths | Weaknesses |
| --- | --- | --- | --- | --- |
| **Vercel** | Proprietary | Managed SaaS | Best-in-class DX, previews | Expensive at scale, vendor lock-in |
| **Railway** | Proprietary | Managed SaaS | Nixpacks, great DX, DB-as-service | Usage-based pricing gets steep |
| **Render** | Proprietary | Managed SaaS | Simple, good docs | Limited regions, expensive |
| **Fly.io** | Proprietary | Managed IaaS | Global edge, fast | Ops-heavy, pricing complexity |
| **Heroku** | Proprietary | Managed SaaS | Original gold standard | Stagnant, expensive, Salesforce-owned |
| **Coolify** | Apache 2.0 | Self-hosted | Feature-complete, strong community | Occasional reliability issues, PHP/Laravel stack |
| **Dokploy** | MIT | Self-hosted | Modern TS stack, clean UI | Smaller ecosystem, newer |
| **CapRover** | Apache 2.0 | Self-hosted | Mature, stable | Dated UI, Docker Swarm-based |
| **Dokku** | MIT | Self-hosted | Heroku buildpacks, battle-tested | CLI-only, no dashboard |
| **Sohwe** | AGPL-3.0 | Self-hosted (+ hosted v2) | Vercel-class DX, broad runtimes, modern stack | Pre-v1, unknown |

---

## 7. Positioning & Differentiation

**Positioning statement:**

> For developers and small teams who want the Vercel experience on their own servers, Sohwe is a self-hosted deployment platform that ships any modern runtime with zero configuration, unlike Coolify and Dokploy which have rougher edges on non-trivial apps, and unlike Vercel which locks you to their cloud and pricing.

**Primary differentiators (ranked by importance):**

1. **Runtime breadth with zero-config builds.** Next.js, Node, Python, Go, Rust, static — all work without a Dockerfile via Nixpacks + smart fallbacks. Coolify supports similar breadth but the DX on edge cases is uneven.
2. **Observability-first.** Live logs, build logs, CPU/memory, and crash alerts are v1 — not bolt-on.
3. **Modern, readable codebase.** TypeScript monorepo, Fastify, Prisma, BullMQ. Contributors can actually understand and extend it, unlike the Laravel/PHP sprawl of Coolify.
4. **Security defaults.** Encrypted env vars, resource limits, isolated Docker networks per app — enabled out of the box, not toggles.
5. **AGPL license** — signals long-term commitment to OSS while protecting the project from closed-source commercial forks.

**What Sohwe is NOT trying to be:**

- Cheaper than Coolify / Dokploy — they're free too.
- A Kubernetes alternative.
- A CI system.
- A cloud provider.

---

## 8. Success Metrics

### 8.1 North Star Metric

**Weekly active Sohwe instances** (self-reported via anonymous, opt-in, privacy-respecting telemetry).

An "active instance" = one that has performed at least one deploy in the last 7 days.

### 8.2 v1 Launch Targets (first 90 days post-public-beta)

| Metric | Target |
| --- | --- |
| GitHub stars | 1,000 |
| Weekly active instances | 200 |
| Total deploys processed across all instances | 10,000 |
| "Install to first successful deploy" time (median, user-reported) | < 10 min |
| Documented runtime support coverage | ≥ 6 runtimes |
| Critical bug reports open > 7 days | < 5 |
| Contributor PRs merged from outside maintainers | ≥ 10 |

### 8.3 Product KPIs (ongoing)

| Dimension | Metric | Target |
| --- | --- | --- |
| **Adoption** | New installs / week | Growth MoM |
| **Activation** | % of installs with ≥ 1 successful deploy within 1 hour | > 70% |
| **Retention** | % of instances active at week 4 | > 40% |
| **Reliability** | Deploy success rate (build + run) | > 95% on standard runtimes |
| **Performance** | Median build time for a Next.js starter | < 90 seconds |
| **Performance** | Median deploy-to-live-URL time (after build) | < 15 seconds |
| **Community** | Discord members | 500 by end of Q1 post-launch |
| **Hosted funnel** (v2) | Self-hosted → hosted conversions | 1–2% |

### 8.4 Anti-metrics (things we will NOT optimize for)

- Raw GitHub stars at the cost of scope creep.
- Feature count parity with Vercel.
- Enterprise logo collection pre-v1.

---

## 9. User Stories

Grouped by release phase (see [Release Plan](#12-release-plan) for timing).

### 9.1 Phase 1 — First Deploy

- As a **first-time installer**, I want to run one command on a fresh VPS and have a working Sohwe instance with HTTPS, so I can start deploying in under 10 minutes.
- As the **owner**, I want to set my admin email and password on first launch, so no one else can access my instance.
- As a **developer**, I want to paste a public GitHub URL and click Deploy, so I don't have to write any config to ship a containerized app.
- As a **developer**, I want to see live build output while my deploy runs, so I can diagnose failures immediately.
- As a **developer**, I want my deployed app to automatically be reachable at a sensible subdomain, so I don't have to touch DNS for every project.

### 9.2 Phase 2 — Broad Runtimes

- As a **developer**, I want to deploy a Next.js app without writing a Dockerfile, so I can focus on building.
- As a **developer**, I want the same zero-config experience for Python, Go, Rust, and static sites.
- As a **developer**, I want to override the build or start command when auto-detection is wrong, so I'm never blocked by the buildpack.
- As a **developer**, I want to attach a custom domain to my app, so I can ship it under my own brand with automatic HTTPS.

### 9.3 Phase 3 — Stateful Apps

- As a **developer**, I want to mount a persistent volume so my app's data survives redeploys.
- As a **developer**, I want to **view and edit** environment variables in the dashboard (similar to Railway or Vercel)—with optional show/hide for values—so I can manage configuration without using the CLI, while knowing values remain **encrypted at rest** and are **never written to build logs, runtime logs, or public responses**.
- As the **owner**, I want to cap memory and CPU per app, so one runaway container can't take down the entire server.

### 9.4 Phase 4 — Observability

- As a **developer**, I want to tail live runtime logs from the dashboard, so I can debug production issues without SSHing into the server.
- As a **developer**, I want to see CPU and memory usage per app, so I know when to scale up.
- As the **owner**, I want to receive a webhook alert (Discord/Slack/generic) when one of my apps crashes, so I'm not learning about outages from users.
- As a **developer**, I want to see the build logs of any past deployment, so I can compare what changed between a working and broken build.

### 9.5 Phase 5 — Git-Push Deploys

- As a **developer**, I want pushing to `main` on GitHub to automatically deploy my app, so I never click Deploy again.
- As a **developer**, I want to deploy from a private repo, so I don't have to make my code public.
- As the **owner**, I want to install a single GitHub App on my org, so every Sohwe app can use the same credentials.

### 9.6 Phase 6 — Multi-User

- As the **owner**, I want to invite teammates by email, so my cofounder can deploy without sharing my password.
- As an **admin**, I want to see every action someone took (who deployed what, when), so I have an audit trail.
- As a **member**, I want to log in and see the apps I'm authorized for, so I can do my work without owner-level powers.

---

## 10. Functional Requirements

Each requirement is tagged with `[P<n>]` for the phase in which it must ship.

### 10.1 Installation & Setup

- `[P1]` Single-command install script for Linux (Ubuntu 22.04+ / Debian 12+).
- `[P1]` First-run setup wizard in the dashboard that creates the owner account and default organization.
- `[P1]` Self-update mechanism (pull new Docker images, run DB migrations, restart).
- `[P2]` Configurable wildcard domain (`*.sohwe.<user-domain>`) for automatic per-app subdomains.

### 10.2 Applications

- `[P1]` Create an application from a public Git repository URL.
- `[P1]` List, view, and delete applications.
- `[P1]` Trigger a manual deployment.
- `[P2]` Configure build mode (`auto` / `dockerfile` / `nixpacks`) per app.
- `[P2]` Override build command and start command.
- `[P2]` Attach a custom domain with automatic Let's Encrypt certificate.
- `[P3]` Configure environment variables: **encrypted at rest** (e.g. AES-256-GCM); **list, view, add, edit, and remove** key/value pairs in the dashboard for **authorized** org members (owner/admin per RBAC); values may use a **reveal/mask** pattern in the UI; API returns decrypted values **only** to authenticated, authorized callers on dedicated env endpoints—not embedded in generic deployment payloads.
- `[P3]` Configure persistent volumes (mount path + optional size hint).
- `[P3]` Configure resource limits (memory MB, CPU).
- `[P5]` Configure a tracked branch and "auto-deploy on push" toggle.

### 10.3 Deployments

- `[P1]` Create a new deployment linked to an application.
- `[P1]` Stream build logs live via SSE.
- `[P1]` Persist build logs for historical viewing.
- `[P1]` Mark deployments `pending` / `building` / `success` / `failed`.
- `[P1]` Roll back: redeploy a previous successful deployment's image.
- `[P3]` Preserve volumes across deployments; never delete them on redeploy.

### 10.4 Runtime

- `[P1]` Start containers via Docker Engine using dockerode.
- `[P1]` Apply Traefik labels for HTTP routing.
- `[P1]` Restart policy: `unless-stopped` by default.
- `[P2]` Health checks respected (from Dockerfile or `/health` default).
- `[P3]` Apply memory/CPU limits.
- `[P3]` Isolate each app on its own internal Docker network.

### 10.5 Observability

- `[P1]` Build log stream (SSE) and persisted build log history per deployment.
- `[P4]` Runtime log tail (SSE) per container.
- `[P4]` Runtime log history (rolling window, last N MB per app).
- `[P4]` CPU / memory / network stats per app, updating at ≤ 5s granularity.
- `[P4]` Crash / OOM detection via Docker events.
- `[P4]` Webhook notifications (Discord, Slack, generic HTTP).

### 10.6 Git Integration

- `[P5]` Install a GitHub App on the organization.
- `[P5]` List repositories available via the installation.
- `[P5]` Clone private repos using installation tokens.
- `[P5]` Receive and verify push webhooks; enqueue a deploy on relevant events.
- `[P5]` Deploy status reported back to GitHub (commit status checks).

### 10.7 Users & Organizations

- `[P1]` Single owner user created at first-run.
- `[P1]` Session-based authentication (HttpOnly cookies, Argon2id password hashing).
- `[P1]` Rate-limited login endpoint.
- `[P6]` Invite members by email with role (`admin` / `member`).
- `[P6]` Revoke or change member roles.
- `[P6]` Audit log of mutating actions.

### 10.8 API

- `[P1]` REST API with Zod-validated request/response shapes.
- `[P1]` SSE endpoints for log streaming.
- `[P2]` Publicly documented API (OpenAPI spec generated from schemas).
- `[P5]` API-key authentication alongside sessions (for CI use cases).

---

## 11. Non-Functional Requirements

### 11.1 Performance

- **Cold install to working dashboard**: < 5 minutes on a 1 vCPU / 2 GB VPS.
- **API p95 latency** (non-streaming endpoints): < 150 ms.
- **Build time**: Next.js starter builds in < 90 s median; small Node API in < 45 s.
- **Deploy switchover**: container replacement completes in < 15 s after a successful build.
- **Dashboard bundle size**: < 500 KB gzipped JS on initial load.

### 11.2 Reliability

- **Deploy success rate**: > 95% on supported runtimes with correct configuration.
- **Graceful worker restart**: in-flight jobs are either completed or cleanly re-enqueued on restart.
- **Zero data loss on instance restart**: DB and volumes survive reboots.
- **Failure isolation**: a crashing user app must never affect Sohwe's own services.

### 11.3 Security

- All secrets (env vars, tokens, webhook secrets) encrypted at rest with AES-256-GCM.
- Environment variable **values** are decrypted **only** server-side for (1) authorized dashboard/API access and (2) injecting into user containers at deploy/start. They must **never** appear in build logs, aggregated audit log lines, error traces, or responses to unauthenticated clients.
- **Audit trail** records env changes (who, which app, when, which keys touched) **without** storing or displaying secret values in audit entries.
- Passwords hashed with Argon2id (64 MB memory, 3 iterations minimum).
- Sessions stored server-side, HttpOnly + SameSite=Lax cookies, no JWTs in browser.
- Rate limiting on login (5 attempts / minute / IP) and webhook endpoints.
- Webhook signature verification mandatory for GitHub events.
- User containers run with dropped Linux capabilities by default; privileged mode off.
- Each app on an isolated Docker network; containers cannot reach Sohwe's own services.
- Dependency vulnerability scanning in CI.
- Responsible disclosure policy documented (`SECURITY.md`).

### 11.4 Scalability (v1 targets, single server)

- **Apps per instance**: up to 50 managed containers on a 4 vCPU / 8 GB host.
- **Concurrent deploys**: up to 3 simultaneously without queue starvation.
- **Log ingestion**: 10 MB/min of aggregate log throughput without dropping lines.

### 11.5 Observability (of Sohwe itself)

- Structured JSON logs from API and worker (via pino).
- Health endpoints on every service (`/health`).
- Optional opt-in anonymous usage telemetry (install count, deploys/week, runtime breakdown — no user data, no repo names).

### 11.6 Portability

- Runs on any x86_64 or arm64 Linux host with Docker Engine 24+.
- No dependency on a specific cloud provider's APIs.
- One-command export of all application configs (for migration to another host).

### 11.7 Usability

- Dashboard responsive down to 1024 px wide; mobile-adequate (read-only) down to 375 px.
- WCAG 2.1 AA contrast compliance.
- Keyboard-navigable for all primary flows.
- Destructive actions (delete app, rotate key) require explicit confirmation.

### 11.8 Documentation

- Install guide, architecture overview, upgrade guide, and runtime-specific guides (Next.js, Python, etc.) present at v1 launch.
- API reference auto-generated from schemas.
- Migration guide from Coolify / Dokploy / Dokku before public launch.

### 11.9 Licensing & Governance

- AGPL-3.0 for the core.
- Contributor License Agreement (CLA) or Developer Certificate of Origin (DCO) for external contributions — required for a future hosted offering under open-core.
- No CLA assignment to a closed-source entity; copyright retained by contributors.

---

## 12. Release Plan

### 12.1 Internal Milestones

| Milestone | Content | Target |
| --- | --- | --- |
| **M0 — Foundation** | Monorepo, schema, auth, empty dashboard | Week 1 |
| **M1 — First Deploy** | Phase 1 complete | Week 3 |
| **M2 — Runtimes** | Phase 2 complete | Week 4 |
| **M3 — Stateful** | Phase 3 complete | Week 5 |
| **M4 — Observability** | Phase 4 complete | Week 7 |
| **M5 — Git Push** | Phase 5 complete | Week 8 |
| **M6 — Multi-user** | Phase 6 complete | Week 9 |
| **v1.0-beta** | Public beta, all above shipped | Week 10 |
| **v1.0** | GA after 4–6 weeks of beta stabilization | Week 16 |

Timeline assumes one primary maintainer working focused side-project hours.

### 12.2 Public Release Strategy

- **Private alpha (pre-M4)** — 10–20 invited users, Discord-only feedback.
- **Public beta (M5 onwards)** — Show HN post, documentation live, GitHub repo public. Bug-fix-heavy period.
- **v1.0 GA** — Blog post, second Show HN, outreach to typical "self-hosted" communities (r/selfhosted, r/homelab, awesome-selfhosted).
- **Post-v1** — Begin v2 work (DBaaS, multi-node, preview deploys). Begin work on hosted Sohwe Cloud.

### 12.3 Versioning

- Semantic versioning for the application.
- Database migrations are forward-only; a migration guide ships with each minor.
- Breaking API changes only on major versions (v2, v3).

---

## 13. Monetization Strategy

Open-core from the start, but **zero paid features in v1**. The OSS must be fully usable and not crippled.

### 13.1 Revenue Streams (post-v1)

1. **Sohwe Cloud (primary)** — fully managed hosted instances. Monthly fee, usage-based for compute/egress. Target: indie hackers who love the product but don't want to maintain a server.
2. **Enterprise tier** — SSO/SAML, SOC 2 reporting, priority support, role-based access control beyond owner/admin/member, dedicated deployment support.
3. **Official paid add-ons** — e.g. advanced metrics + long-term log retention, backup-as-a-service, multi-region failover. Opt-in only, source-available where feasible.
4. **Support contracts** — for self-hosted enterprise installations.

### 13.2 Pricing Philosophy

- **Self-hosted OSS**: always free, always fully featured for the use cases scoped in this document.
- **Hosted**: priced below Vercel/Railway for equivalent workloads; transparent egress pricing.
- **Enterprise**: per-instance or per-seat, sales-led.

### 13.3 Why AGPL Supports This

AGPL prevents a cloud competitor from taking Sohwe, running it as a closed-source hosted service, and outcompeting the official hosted version — the "MongoDB / Elastic problem." Copyleft SaaS coverage is the point.

---

## 14. Risks & Assumptions

### 14.1 Assumptions

1. There is meaningful and growing demand for self-hosted PaaS (evidence: Coolify's growth, r/selfhosted traffic, HN sentiment toward cloud prices).
2. Docker Engine is a stable enough abstraction to build on for v1 — Kubernetes is not required.
3. Nixpacks (or Buildpacks) can cover 80%+ of target apps out of the box.
4. A solo/small-team maintainer can ship this scope in ~10 focused weeks.
5. AGPL will not meaningfully reduce community adoption at the target segment (indie + small teams). Corporate adoption will be limited but that's accepted.

### 14.2 Top Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Scope creep delays v1 indefinitely | High | High | Strict phase gates; anything not in "v1 functional requirements" ships in v2. |
| Nixpacks fails on many real-world apps | Medium | High | Always allow Dockerfile override; publish a compatibility matrix; contribute fixes upstream. |
| Coolify / Dokploy ship the same features first | Medium | Medium | Differentiation lives in code quality and DX, not feature list. Avoid direct feature races. |
| Single-maintainer burnout | High | High | Set sustainable pace; write onboarding docs early; actively recruit contributors by M3. |
| Docker Engine deprecation or major API break | Low | High | Abstract Docker calls behind a `ContainerRuntime` interface early; Podman compatibility becomes a v2 option. |
| AGPL scares away corporate adopters | Medium | Low | Accepted trade-off; corporate tier will be a separate commercial license if demand emerges. |
| Security incident before reaching v1 | Low | Critical | Threat-model at each phase boundary; no v1 launch without an external security review. |
| Hosted offering distracts from OSS before OSS is mature | Medium | High | Do not start Sohwe Cloud until v1.0 GA + 6 months of stability. |

---

## 15. Open Questions

Items to resolve before or during v1.

1. **Install script distribution**: curl-pipe-bash vs. official Docker image vs. both? (Industry trend: both, with signed scripts.)
2. **Telemetry**: opt-in or opt-out? Recommended: opt-in at first, opt-out once trust is established. Decide before beta.
3. **Buildpack fallback**: if Nixpacks fails, do we fall back to Paketo Buildpacks, or just surface the failure? (Recommend: surface failure, document manual Dockerfile path.)
4. **Instance naming / slugs**: collision handling when two orgs want the same app slug. (Recommend: org-scoped slugs; global uniqueness not required.)
5. **Backup story for v1**: do we ship a built-in backup/restore for the Sohwe instance DB and volumes, or document a manual `pg_dump` + `docker volume` process? (Recommend: documented manual process for v1; built-in for v1.x.)
6. **CLI tool**: ship a Sohwe CLI with v1 or defer? (Recommend: defer to v1.1. Dashboard + API cover the user stories.)
7. **Branding**: logo, color palette, marketing site before or after Show HN?

---

## 16. Glossary

| Term | Definition |
| --- | --- |
| **Application** | A deployable unit in Sohwe — a Git repository plus configuration. |
| **Deployment** | A specific build-and-run attempt of an application, identified by a commit SHA and image tag. |
| **Organization** | The top-level tenant in Sohwe. A single Sohwe instance hosts one org in v1. |
| **Owner** | The initial user created at first-run; has all permissions. |
| **Nixpacks** | Open-source buildpack-style tool that auto-detects a project's runtime and produces a Docker image. |
| **Traefik** | Reverse proxy that auto-discovers Docker containers via labels and handles HTTPS via Let's Encrypt. |
| **Volume** | A Docker named volume mounted into an app container to persist data across redeploys. |
| **SSE** | Server-Sent Events — one-way server-to-client streaming over HTTP; used for log tailing. |
| **AGPL-3.0** | GNU Affero General Public License v3; copyleft license that extends to network-hosted services. |

---

## Change Log

| Date | Change | Author |
| --- | --- | --- |
| 2026-04-21 | Initial draft | — |
