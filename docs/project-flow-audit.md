# Project setup and logs audit

Date: 2026-10-03

Status: findings and proposed work; no implementation in this audit

## Why this exists

Setting up a multi-service project and finding its logs remain difficult, even
after the first project onboarding pass. Creating services was the main setup
friction reported by a user. This audit compares the current project flow with
the easier single-application flow and records the code paths behind each
finding. It is a static code audit, not a reproduction using the user's
repository.

Projects must still support HTTP services, private workers, and a one-shot
release job from one commit. The goal is to make those differences clear in the
UI while reducing manual configuration and making each release diagnosable.

## Findings, in implementation order

### P0: Make the selected service build the selected source

The project form records `serviceDirectory` and `workspaceSelector`, and the
API persists both (`apps/dashboard/src/routes/projects.tsx:626`,
`apps/api/src/routes/projects.ts:329`). The project worker's `buildAppImage`
call does not pass `appDirectory`; there is no project worker or builder use of
`workspaceSelector` (`apps/worker/src/project-deploy.ts:442`,
`packages/builder/src/index.ts:352`). Nixpacks can therefore build from the
repository root despite the directory selected in the form. In a workspace,
passing the directory alone may still leave Nixpacks using the root as its
source; package selection must have defined behavior too
(`packages/builder/src/index.ts:69`).

The automatic image reuse key omits directory and workspace selector
(`apps/worker/src/project-deploy.ts:168`). Services intended to build from
different directories can consequently reuse an image. An explicit shared
image group also reuses the first built image without checking whether members
have compatible build settings (`apps/worker/src/project-deploy.ts:176`).

**Change:** define the effective build context, package selector, and command
semantics for each build mode; apply them in the worker/builder; include every
effective image input in automatic reuse; validate explicit shared image groups
or show their consequences before release. Keep Dockerfile paths
repository-relative where the current builder expects them.

**Acceptance:** two services from different nested directories produce the
intended images, and a pnpm workspace service runs the intended package build
and start commands. Tests cover distinct-directory cache keys and deliberate
shared-image reuse.

### P1: Guide repository-to-service setup

Project creation asks for a raw URL, starts with `main`, and requires a manual
inspection click (`apps/dashboard/src/routes/projects.tsx:283`,
`apps/dashboard/src/routes/projects.tsx:463`). Applications already have a
connected GitHub repository picker, default-branch lookup, automatic
inspection, and required-variable checks
(`apps/dashboard/src/components/apps/CreateAppDialog.tsx:111`,
`apps/dashboard/src/components/apps/CreateAppDialog.tsx:142`,
`apps/dashboard/src/components/apps/CreateAppDialog.tsx:179`).

Project inspection lists candidates, but applying one requires choosing among
"Use for first service", "Add HTTP", and "Add worker"; a default Web service is
already present (`apps/dashboard/src/routes/projects.tsx:287`,
`apps/dashboard/src/routes/projects.tsx:489`). This makes it easy to leave an
unintended service or choose the wrong process type. The create API validates
the submitted shape but does not inspect repository access or the branch
before saving (`apps/api/src/routes/projects.ts:264`).

**Change:** reuse the application repository and branch picker; inspect after
branch selection; present detected processes as selectable service proposals;
ask users to confirm HTTP/worker/release roles; show the evidence and final
build plan on a review screen. Keep manual editing for repositories that cannot
be inferred reliably. Validate access and branch before starting the first
release.

**Acceptance:** a connected private repository with a non-`main` default
branch can be selected without typing a URL or branch. A multi-service
candidate set creates exactly the services selected by the user.

### P1: Complete dependencies before the first release

"Create and release" saves and queues immediately
(`apps/dashboard/src/routes/projects.tsx:378`). Managed datastore bindings are
only available in the existing project's Configure dialog
(`apps/dashboard/src/components/projects/EditProjectDialog.tsx:894`). A project
that needs Postgres or Redis must therefore be saved as a draft, configured,
and released separately, although the primary button encourages immediate
release. Project creation also lacks the application's prompt and gate for
required variables (`apps/dashboard/src/components/apps/CreateAppDialog.tsx:410`).

**Change:** make first release a guided sequence: select services, fill required
shared/service variables, bind existing datastores or create them, review
dependencies and commands, then release. The API may create the draft before
binding, but the UI should keep the user in one continuous setup flow. Explain
what is required versus optional, and surface missing inputs beside the
affected service.

**Acceptance:** a new project requiring a managed database and a migration job
can complete setup and start its first release without leaving the flow or
attempting a known-incomplete release.

### P1: Give projects a navigable home and release history

The dashboard registers only a `/projects` list route
(`apps/dashboard/src/router.tsx:128`). Its project cards show the latest release
and service status badges, with logs toggled inline
(`apps/dashboard/src/routes/projects.tsx:994`). The list API returns five
releases, and the detail API can return thirty, but the UI does not offer a
release history or a URL for a specific release
(`apps/api/src/routes/projects.ts:409`). After creation, the app flow opens its
deployment route; the project flow closes the dialog and highlights a card
(`apps/dashboard/src/components/apps/CreateAppDialog.tsx:284`,
`apps/dashboard/src/routes/projects.tsx:367`).

**Change:** add project Overview, Releases, Logs, Variables, and Settings
routes. Open the new release after "Create and release". A release detail
should show clone, each image build, release job, each service start/readiness,
and promotion, with status, duration, errors, and direct links to the relevant
logs. Show each HTTP service's generated/custom URL on the overview; routing
already creates a generated route (`apps/worker/src/project-container-spec.ts:62`).

**Acceptance:** a user can open any retained release by URL, identify the
failed step, and reach that step's output without searching a project card.

### P1: Build a full project log viewer

The project service log component exposes only a service selector, flattens
events into strings, holds the last 500 displayed lines, and has no visible
connection/error state (`apps/dashboard/src/routes/projects.tsx:906`). This
discards timestamps, severity, release and container identity available in the
events. The API already offers persisted history and live SSE filtered by
service, release, stream, level, and cursor
(`packages/types/src/index.ts:536`, `apps/api/src/routes/projects.ts:1471`).
Applications already have a larger log pane with follow, copy, download, and
reconnecting state (`apps/dashboard/src/components/apps/LogPane.tsx:23`,
`apps/dashboard/src/components/apps/RuntimeLogViewer.tsx:14`).

**Change:** use a dedicated project Logs route with service, release,
build/release-job/runtime, stdout/stderr, severity, and time filters. Keep
structured metadata in the UI. Add search, pause/follow, paged history,
connection state, copy, and bounded download. Make release-job output an
explicit step and filter, since it is essential for migration failures.

**Acceptance:** after a failed migration, a user can select that release and
release job, read its historical stderr, and retain context after a refresh or
SSE reconnect.

### P1: Improve project build-log delivery and diagnostics

The project build panel polls a release-detail endpoint every two seconds and
receives all service build logs even when one service is selected
(`apps/dashboard/src/routes/projects.tsx:970`,
`apps/api/src/routes/projects.ts:1445`). It displays output in a small `pre`
without follow, search, copy, or download. The corresponding application
viewer streams a selected deployment and includes a failure summary
(`apps/dashboard/src/components/apps/BuildLogViewer.tsx:7`,
`apps/dashboard/src/components/apps/DeploymentsPage.tsx:99`).

**Change:** add a per-service build-log stream or paged endpoint and reuse the
log pane. Show recognized clone, branch, Dockerfile, build, release-job, and
readiness failures beside the release step, with a link to the setting that
needs correction. Keep raw build output restricted to admins because it can
be secret-adjacent; provide a safe status and failure summary to other
permitted project viewers.

**Acceptance:** a failing build points to one service and one actionable
cause; an admin can follow and retrieve that service's raw output without
fetching every sibling service's logs repeatedly.

### P2: Make ongoing service changes manageable

The Configure dialog expands every service's many fields at once
(`apps/dashboard/src/components/projects/EditProjectDialog.tsx:574`). Adding a
service requires JSON mode even though the API supports service creation
(`apps/dashboard/src/components/projects/EditProjectDialog.tsx:867`,
`apps/api/src/routes/projects.ts:698`). Saving configuration makes multiple
independent API writes; if a later write fails, earlier changes can remain
saved. Variables and datastore bindings in the same dialog save immediately
(`apps/dashboard/src/components/projects/EditProjectDialog.tsx:416`,
`apps/dashboard/src/components/projects/EditProjectDialog.tsx:819`,
`apps/dashboard/src/components/projects/EditProjectDialog.tsx:929`).

**Change:** use focused service settings pages with normal Add/Remove actions.
Distinguish immediate-save controls from draft changes, or move to one
review-and-apply operation for topology changes. Validate the whole proposal
before writes and report partial failures accurately. Replace comma-separated
dependency slugs with selections of existing services and explicit started or
healthy conditions (`apps/dashboard/src/routes/projects.tsx:750`).

**Acceptance:** a user can add a worker, bind it to a datastore, set an API
dependency, and release it through the form; a failed save identifies exactly
what applied.

## Validation before calling the flow complete

Use the Phase 9 acceptance repositories in `UPCOMING_PLANS.md`: `web-app`,
`qqueue`, and `FleetOptics-Backend`. Test a connected private repository,
nested Dockerfiles or workspace builds, managed datastore bindings, a
one-shot migration, HTTP and worker services, failed migration logs, worker
restart/log continuity, and rollback. The existing acceptance notes also
require retaining the old live release when a migration fails
(`UPCOMING_PLANS.md:162`).

No code changes or live fixture validation were performed for this audit.
