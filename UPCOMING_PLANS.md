# Upcoming Plans

This file tracks work that remains open. Completed Phase 9 items are retained as context for the remaining acceptance criteria. See `CHANGELOG.md` for release history.

The prioritized plan for making single-application setup easier is in
[`docs/application-onboarding-priorities.md`](./docs/application-onboarding-priorities.md).
Priorities 1–2 (Create and deploy; Reduce manual form entry) are implemented.
Priorities 3–9 remain open.
The onboarding plan also records the intended full dashboard redesign: ease of
use and clean UI, with Vercel and Railway as references and a dedicated logs UI
improvement. Scope and sequencing will be reviewed before implementation.

## Phase 9 - Monorepo and Multi-Service Deployments

Status: **in progress from a repository audit on 2026-09-10**

Foundation delivered on 2026-09-10: an existing application can select a
repository-relative nested Dockerfile, a named multi-stage target, and an
optional runtime command while keeping the repository root as build context.
The settings are validated against traversal/symlink escapes, exposed in the
dashboard/API, and preserved by portable bundles. The follow-up project/service
slice adds a parallel deployment unit rather than changing the legacy
`Application` behavior: coordinated releases, private workers, one-shot jobs,
project networking, datastore bindings, and persisted per-service logs.

The original deployment unit is one `Application`: Sohwe clones a repository,
builds its root, creates one container, and always gives that container an HTTP
route. That can be made to build a simple pnpm workspace with manual command
overrides, but it is not the production topology used by the audited
repositories. A deployable project needs to own several services built from
the same commit: routed web/API processes, unrouted workers, and a one-shot
release job for migrations. `Project` now supplies that topology while keeping
the application path backward compatible.

The repository root must remain available as the build context. Treating
`apps/web` as the Docker context would hide `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, and sibling `workspace:*` packages. Service directory,
workspace/package selector, Dockerfile path, and Docker build target are
separate settings layered on top of that root context.

### Project and service model

- [x] Add a project/deployment-group model that owns one Git repository and
      branch plus multiple services built from the same commit SHA.
- [x] Add service kinds: `http` (port, domains, Traefik), `worker` (long-running,
      no port or generated domain), and `release`/`job` (run to completion, no
      restart or routing).
- [x] Let several services reuse one built image with different commands, so a
      worker and media worker do not rebuild identical Dockerfile stages.
- [x] Put project services on one private project network with stable internal
      DNS names, while keeping only explicitly routed HTTP services on the
      Traefik network.
- [x] Allow one managed Postgres/Redis datastore binding to inject consistent
      connection settings into every selected service in a project.
- [ ] Add an S3-compatible dependency path: documented external S3/R2 binding
      first, then optional managed MinIO with encrypted credentials, private
      networking, bucket initialization, a persistent volume, and backup
      guidance.
- [x] Carry project, service, dependency, command, routing, and build settings
      in portable bundles without exporting secret values unless the existing
      encrypted-secret option is selected.

### Build configuration

- [x] Keep `repositoryRoot` as the default build context and add independently
      validated `serviceDirectory` / workspace selector fields.
- [x] Add `dockerfilePath` relative to the repository root and `dockerTarget`
      for multi-stage Dockerfiles; reject absolute paths and `..` traversal.
- [ ] Add per-service build and start/command overrides, plus optional install
      command configuration where the build engine supports it.
- [ ] Detect and honor the root `packageManager` declaration and lockfile for
      pnpm 9 and 10 instead of silently falling back to an older pnpm. Keep the
      resolver extensible so later pnpm majors can be added without redesigning
      service configuration.
- [ ] Support Node 22 and 24 explicitly and fail with a named compatibility
      error when a requested toolchain is unavailable.
- [ ] Replace or supplement pinned Nixpacks 1.29.1. Upstream Nixpacks is in
      maintenance mode; evaluate Railpack against the acceptance repositories
      while retaining Dockerfile mode as the deterministic escape hatch.
- [ ] Cache the repository checkout and dependency/build layers across sibling
      services without allowing one organization to read another's source or
      cache contents.
- [ ] Show the resolved context, Dockerfile, target, package manager, service
      kind, and commands in the build plan before deployment.

### Coordinated deployment

- [x] Build every required service image before changing the running release.
- [x] Run the release command/migration exactly once, after required datastores
      are healthy and before new API/worker containers start. Preserve its
      separate logs and exit status.
- [x] Do not replace the current release when a build or release job fails.
- [x] Start services in dependency order and gate HTTP promotion on configurable
      liveness/readiness checks; workers need process/container health without
      an HTTP probe.
- [x] Record one project release with per-service deployment states and a shared
      commit SHA. Coordinated rollback restores the prior service images while
      warning that database migrations remain forward-only.
- [ ] Add per-service resource limits, runtime logs, metrics, crash alerts, and
      restart policy. A worker must not receive a fake domain merely to use
      those facilities.
- [ ] Add path filters for push deploys so a change can rebuild only affected
      services, with shared-package paths able to fan out to several services.

### Per-service logging

- [x] Label every container with project, service, release, deployment, and
      service-kind identifiers so logs never mix between sibling processes.
- [ ] Capture `stdout` and `stderr` for every HTTP service, private service,
      worker, scheduled process, and one-shot release job. Preserve source
      stream, container timestamp, container/restart identity, and raw message.
- [ ] Keep build, release-job, and runtime logs as distinct streams, with an
      aggregated project view that can filter by service, stream, release,
      level, and time range.
- [x] Persist a bounded runtime history across dashboard disconnects, Sohwe
      worker restarts, container restarts, and service redeploys. Do not rely
      only on live Redis pub/sub or Docker's most recent lines.
- [ ] Add per-project retention and storage limits with safe defaults, automatic
      pruning, and visible usage. Configure bounded Docker log rotation too, so
      the daemon's local log files cannot exhaust the host disk.
- [x] Stream logs live over authenticated SSE with reconnect cursors and no
      gaps or duplicates at the persisted/live handoff. Apply organization and
      role checks to list, stream, search, and download operations.
- [x] Redact configured secret values before either persistence or broadcast,
      covering shared project variables, service variables, build variables,
      datastore credentials, and release-job output. Never depend on the UI to
      hide a value already stored by the API.
- [ ] Bound individual line/event size and ingestion rate, preserve multiline
      stack traces without unbounded buffering, and expose dropped/truncated
      counts rather than silently losing output.
- [ ] Add service and project log views with pause/resume, follow mode, search,
      severity and time filters, copy, and bounded download. Make container
      starts, stops, health transitions, OOM kills, and restart counts visible
      alongside application output without rewriting the application's lines.
- [ ] Keep an auditable record of log downloads, retention changes, and external
      sink configuration without recording log contents or secret values in the
      audit log.
- [ ] Later: optional forwarding to a user-owned Loki/OpenTelemetry/syslog sink
      with bounded buffering and failure isolation; remote logging failure must
      never block or crash an application service.

### Compose-assisted onboarding

- [ ] Add a read-only Compose preview/importer for the safe subset needed by
      these repositories: build context, Dockerfile, target, command, ports,
      environment key names, named volumes, health checks, and `depends_on`.
- [ ] Resolve Compose interpolation during preview, show unsupported fields,
      and require explicit mapping of secrets and managed/external dependencies
      before creating anything.
- [ ] Refuse privileged containers, host PID/network modes, Docker socket
      mounts, arbitrary host bind mounts, and other host-level capabilities by
      default. Import must never execute repository Compose files directly.

### Acceptance repositories

- [ ] `web-app` (Chale Check): pnpm 10; build nested web/API/worker Dockerfiles;
      run web, API, email/maintenance worker, and memory-limited media worker
      from one commit; bind Postgres/Redis and external R2; preserve the
      API-before-worker migration/health ordering.
      Local fixture evidence on 2026-09-11 (`dev` at `794540c`): all three
      production images build, including pnpm 10.33.2, the glibc media package,
      and the web build argument; API `/health`, web, email worker, and media
      worker boot in disposable containers. Fresh-database acceptance is
      blocked in the fixture itself: migration
      `1784300000001_live_activity_presets_icon_details` runs before the table
      creator `1783887427000003_live_activity_presets`, so the one-shot release
      correctly fails and must not be promoted. Keep this item open until that
      repository migration order is repaired and the full Sohwe-hosted release
      is exercised with real bindings.
- [ ] `qqueue`: pnpm 9 + Turborepo; deploy static web, API, and unrouted worker;
      run Prisma migration once; bind Postgres/Redis and external S3 or managed
      MinIO; serve web and API routes through Sohwe rather than its bundled
      Caddy edge.
- [ ] `FleetOptics-Backend`: pnpm 10; build the root Dockerfile's `api`,
      `worker`, and `migrate` targets; run the migration target once; route only
      the API; bind Postgres/Redis and external S3/R2.
- [ ] For every fixture: deploy from a private GitHub repository, verify
      workspace dependencies resolve, prove push deploy/path filtering, inspect
      each process's isolated live and historical logs/metrics, restart a worker
      and prove log continuity, force a failed migration and confirm its output
      is retained while the old release stays live, verify configured secrets
      never enter stored or streamed logs, then verify coordinated rollback on
      a real VPS.

Phase 9 is complete only when all three fixtures can be represented through the
dashboard/API without editing the repositories solely to satisfy Sohwe. Repo
changes that are ordinary production configuration (application secrets,
public URLs, or choosing external object storage) are allowed; flattening a
monorepo, merging workers into an HTTP process, or moving Dockerfiles to the
root is not. These repositories are acceptance evidence, not named presets or
special cases in Sohwe: the same project/service composer and API must describe
them and unrelated repositories without repository-specific code paths.

## Long term - Multi-Host Kubernetes Runtime

Status: **long-term direction; explicitly not required for Phase 9 or the
single-host rolling-deployment milestone**

Sohwe should first make projects, services, releases, replicas, health-gated
rollouts, and logging reliable on one Docker host. Multi-host scheduling should
then use Kubernetes rather than growing Sohwe into a bespoke cluster scheduler.
The dashboard and API should continue to expose Sohwe concepts instead of
requiring ordinary users to understand raw Kubernetes resources.

- [ ] Keep the Phase 9 domain model runtime-neutral:
      `Project -> Service -> Release -> Replica`; do not make one mutable Docker
      container ID the identity of a service or release.
- [ ] Introduce an internal runtime contract after the Docker behavior is
      stable. Keep Docker as the default implementation and add Kubernetes as a
      separate execution backend rather than branching deployment logic
      throughout the API and worker.
- [ ] Map HTTP/worker services to Kubernetes Deployments, release/migration jobs
      to Jobs, private discovery to Services, domains to Ingress/Gateway API,
      variables to Secrets/ConfigMaps, and persistent volumes to PVCs.
- [ ] Push immutable, content-addressed release images to a configured OCI
      registry. Multi-host releases must never depend on images that exist only
      in one machine's local Docker daemon.
- [ ] Make the Sohwe control plane safe to run independently of workload nodes:
      no required local Docker socket, durable deployment state, idempotent
      reconciliation, leader election for singleton controllers, and recovery
      after a control-plane restart.
- [ ] Reuse Phase 9 rollout policy for Kubernetes rolling updates and optional
      blue/green releases: replica count, readiness, `maxSurge`,
      `maxUnavailable`, drain timeout, promotion, and rollback.
- [ ] Centralize logs, events, and metrics across nodes with the same
      project/service/release/replica identity and authorization rules as the
      single-host logging UI. No feature may assume logs live on the API host.
- [ ] Define cluster connection, namespace isolation, service-account/RBAC,
      network policy, pod security, registry credentials, quotas, and secret
      handling before accepting a production cluster.
- [ ] Treat stateful workloads separately: support externally managed databases
      first; do not imply HA merely because an app has several pods. Operators,
      replicated storage, backup/restore, and failover need their own explicit
      design and verification.
- [ ] Add cluster capacity and scheduling visibility, per-service placement and
      resource requests/limits, autoscaling only after metrics are trustworthy,
      and clear failure reporting for unschedulable replicas.
- [ ] Prove the backend with a disposable multi-node cluster before production:
      deploy one of the Phase 9 acceptance projects, roll it with live traffic,
      drain/fail a node, retain logs across rescheduling, run a migration once,
      and verify service discovery, rollback, and tenant isolation.

This track provides multi-host resilience only when the control plane, ingress,
registry, storage, and datastores are also deployed without single points of
failure. Several replicas placed on one node are horizontal scaling and
deployment protection, not host-level high availability.

## Other follow-ups

- [ ] Add GitLab/Gitea integrations with their own credentials and webhook paths.
- [ ] Encrypt public managed-datastore connections with TLS. Add datastore metrics and logs, data backups, an admin-only data browser/SQL console, and more engines when prioritized.
- [ ] Verify custom-domain DNS record apply and certificate issuance on a real host. Explore Domain Connect and additional safe provider API drivers.
- [ ] Test backup export/restore orchestration with a Docker double or live daemon.
- [ ] Verify the pre-v0.3.8 migration auto-baseline against a real upgraded host; CI already covers a seeded database.
