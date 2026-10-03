# Application onboarding priorities

Status: **priorities 1–9 implemented; live fixture validation remains**
Last reviewed: 2026-10-03

## Goal and scope

Make the path from an existing Git repository to a working **single application**
shorter and easier to recover when it fails. This plan concerns app setup inside
Sohwe, not installing Sohwe on a server or configuring multi-service Projects.

Target flow: **choose or paste a repo → review suggested settings → add required
variables → deploy → open the URL**. An admin must remain able to inspect and
override every suggestion.

This plan tracks the sequence of work. Priorities 1–9 are implemented; the
first release acceptance repositories still need to be exercised live.

## Dashboard redesign direction

The onboarding work is part of a broader redesign of the current dashboard UI,
not just a series of form changes. Prioritize ease of use and a clean visual
layout across application creation, deployment, monitoring, settings, and
recovery. Use Vercel and Railway as references for flow and clarity while
keeping Sohwe's own capabilities and terminology visible.

- Make the next useful action and current status easy to find. Keep common
  choices prominent and reveal detailed controls when they are needed.
- Design creation, deployment progress, success, and failure as one continuous
  journey. Keep navigation and terminology consistent across those screens.
- Redesign the logs UI as a dedicated part of this work. Live build logs and
  runtime logs need readable structure, clear source and status context,
  useful search and filtering, and obvious paths from an error to the setting
  or action that can resolve it. Preserve access to raw output.
- Review the whole dashboard for hierarchy, spacing, responsiveness, and
  accessibility so isolated improvements do not leave an inconsistent UI.

Scope and sequencing for the broader redesign and logs view need review before
implementation. Priority 2 improves the creation form, but the full dashboard
redesign remains open.

## Current Sohwe baseline

- The new-app dialog has a searchable picker for repositories shared with the
  connected GitHub App. Picking one fills the URL, default branch, name, and
  slug. Pasting an HTTPS Git URL also suggests name and slug while preserving
  manual edits. The dialog flags malformed URLs and known slug collisions
  beside their fields.
- `auto` build mode already uses a Dockerfile when present and otherwise tries
  Nixpacks. Branch and port remain visible with their defaults. Dockerfile,
  command, and custom-domain controls are under Advanced settings.
- The new-app dialog now defaults to **Create and deploy**, then opens the
  first deployment's live build log. **Save for later** creates an idle app.
  If the deploy request fails after creation, the dialog keeps the saved app
  visible and offers **Retry deploy** without creating the app again.
- Scoped variables can be entered individually or pasted from `.env` in the
  creation dialog. They are encrypted in the same database write that creates
  the app, before the first deployment request. The existing variable editor
  remains available after creation.
- Push-to-deploy is available for a connected GitHub repository but is off by
  default. Generated app URLs, live build logs, and custom-domain guidance
  already exist.
- The new-app form inspects the selected branch in a temporary checkout and
  shows commit, candidate directories, detected files, suggested builder,
  Dockerfile path, commands, and port before creation. Each value can be
  changed. Docker builds retain the repository root as context; nested
  JavaScript workspaces retain it for Nixpacks too. Repository branches load
  into a dropdown with the remote default first and manual entry as fallback.

Code entry points: [new-app dialog](../apps/dashboard/src/components/apps/CreateAppDialog.tsx),
[application routes](../apps/api/src/routes/applications.ts),
[variable editor](../apps/dashboard/src/components/apps/VariablesManager.tsx),
[deployment view](../apps/dashboard/src/components/apps/DeploymentsPage.tsx).

## Comparison that informs the plan

| Platform behavior | Relevant lesson for Sohwe |
| --- | --- |
| [Netlify repository import](https://docs.netlify.com/manage/projects/add-new-project/) suggests framework build settings and, for detected monorepos, candidate sites. Its import ends with deployment. | Suggest app-specific settings before the first build and make deployment part of creation. |
| [Vercel Git import](https://vercel.com/docs/git) lets users select a repo, review framework/root/build settings and variables, then deploy. | Present a compact review of what Sohwe will build and run; expose overrides only when needed. |
| [Railway services](https://docs.railway.com/services) link a repo to a container service and deploy new commits. [Railway's monorepo import](https://docs.railway.com/deployments/monorepo) detects deployable JavaScript packages. | Railway is the closest comparison for Sohwe's container model; repo inspection and app-directory selection would remove manual guesswork. |
| [Railway variables](https://docs.railway.com/variables) suggest names from `.env` files. | Let users configure variables before the first deploy; suggest keys without copying secret values from source. |
| [Netlify's `netlify.toml`](https://docs.netlify.com/build/configure-builds/file-based-configuration/) and [Vercel's `vercel.json`](https://vercel.com/docs/project-configuration/vercel-json) keep build preferences with source code. [Render Blueprints](https://render.com/docs/blueprint-spec) can prompt for secret values without storing them in the file. | A small, documented `sohwe.yaml` could make a repository easier to import repeatedly while keeping instance settings and secrets in Sohwe. |

Netlify and Vercel optimize heavily for sites and framework-specific hosting.
Sohwe runs arbitrary containers, so detected commands, ports, and directories
must be **suggestions**, not hidden assumptions.

## Prioritized backlog

| Order | Priority | Change | Why now | Size |
| --- | --- | --- | --- | --- |
| 1 | P0 | **Create and deploy** as the primary action, opening the new deployment's live log. Keep **Save for later** for apps needing more setup. If deployment enqueueing fails after creation, show the saved app and a clear retry action; never silently create a second app. **Implemented.** | Removes an unnecessary step from every first deploy. | Small |
| 2 | P0 | **Reduce manual form entry.** Derive name and slug from pasted Git URLs as well as picker selections; preserve user edits. Put Docker targets, command overrides, and custom domain under an Advanced section. Keep branch and port visible with clear defaults. Validate slug collisions and malformed URLs in context. **Implemented.** | Makes the common case understandable without removing control. | Small–medium |
| 3 | P0 | **Variables before first deploy.** Put Sohwe's existing scoped variable editor and bulk paste in the creation flow. Save encrypted variables before queueing the build. Treat creation and initial configuration as one reliable operation, or provide a recoverable draft if a later step fails. **Implemented.** | Prevents avoidable first-build failures and secret handling workarounds. | Medium |
| 4 | P1 | **Repository inspection and build-plan preview.** After repo selection, inspect the chosen branch and propose build mode, root or app directory, Dockerfile, likely start command, and container port. Show the evidence and resolved build plan. Preserve repository-root build context for workspaces and let users override each suggestion. **Implemented; live private-repo acceptance remains.** | Highest potential to improve success for unfamiliar repos and monorepos, but requires careful design and validation. | Large |
| 5 | P1 | **Repository config file and deployment docs.** Support `sohwe.yaml` v1 with validation, required variable prompts, deploy-time resolution, and visible source/override rules. Publish a quickstart, field reference, examples, schema, and troubleshooting guide. **Implemented; live fixture validation remains.** | Lets teams commit repeatable, reviewable app preferences and makes unfamiliar deployments easier to understand. | Medium–large |
| 6 | P1 | **First-deploy diagnosis.** Give specific remedies for inaccessible repos, missing branches, wrong Dockerfile paths, missing start commands, port mismatches, and missing variables. Link each diagnosis to the setting that fixes it, while retaining raw logs. **Implemented; live fixture validation remains.** | Reduces time from failed build to a working app. | Medium |
| 7 | P1 | **Git push behavior in setup.** When a repo comes from a connected GitHub installation, clearly offer push-to-deploy with the selected branch and explain the default. Do not show an enabled state for a repo that cannot receive webhooks. **Implemented.** | Aligns setup with the expectation created by Git-based deploy platforms. | Small–medium |
| 8 | P2 | **Reusable app templates or a Deploy with Sohwe link.** A link prefills the repo, branch, and config path; `sohwe.yaml` supplies non-secret settings and required variable names, and users supply values. **Implemented.** | Helps repeated/common setups after the core import path works. | Medium–large |
| 9 | Later | **Preview deployments and additional sources.** Manual branch previews run as isolated applications without copied secrets; public image import adds a non-Git source. **Implemented.** Automatic PR lifecycle and local-directory import remain possible follow-ups. | Useful platform capabilities, but they do less to fix the first production deploy and add significant runtime complexity. | Large |

## `sohwe.yaml` v1

Implemented in [`sohwe-yaml.md`](./sohwe-yaml.md), with the [first-app guide](./deploy-first-app.md), [JSON Schema](./schemas/sohwe.v1.schema.json), and [troubleshooting guide](./deployment-troubleshooting.md). The design notes below remain as background; `application.directory`, `build.command`, and `build.startCommand` are also supported.

Use **`sohwe.yaml` at the repository root** as the standard name. It is easier
to discover than a hidden `.sohwe` directory and follows the convention of
committed deployment configuration. For a monorepo, let the admin choose an
alternative repository-relative file such as `apps/api/sohwe.yaml`; that path
selects the config file and does **not** change the Docker build context.
Keep v1 to one application per file. Multi-service Projects need their own
design rather than an overloaded app schema. This repository file is distinct
from Sohwe's existing `.sohwe.json` backup bundles, which export instance
configuration for restore.

Example:

```yaml
version: 1
application:
  name: api                    # Import-time display name suggestion
  build:
    mode: dockerfile            # auto | dockerfile | nixpacks
    dockerfile: apps/api/Dockerfile  # Relative to repository root
    target: runtime             # Optional Docker stage
  runtime:
    port: 3000                  # Port the container listens on
    command: node dist/server.js # Optional override
  variables:
    - key: DATABASE_URL
      scope: runtime            # runtime | build | both
      required: true            # Prompt for a value during import
```

V1 should include only **portable app preferences**: an import-time name suggestion, build
mode, repository-relative Dockerfile path and target, optional build/start
commands where the selected builder supports them, runtime command, port, and
required variable **names/scopes/descriptions**. Keep Git URL, tracked branch,
app slug, custom domains, auto-deploy choice, datastore bindings, and variable
**values** in the Sohwe instance. Do not read `.env` values into the config.

### Loading and precedence to design before implementation

1. After the chosen branch is inspected, look for `sohwe.yaml` (or the
   explicitly selected config path). Validate `version` and every field, then
   show the resulting build plan **before** creating or deploying the app.
2. Prefer explicit dashboard overrides for this Sohwe instance; use file values
   for fields without overrides, then repository detection, then Sohwe defaults.
   Label each effective value with its source so a user can explain a deploy.
3. On later deployments, read the config from the exact commit being built.
   File changes affect only fields without dashboard overrides. The display
   name is an import-time suggestion and does not rename an existing app.
   Show the resolved config and commit in deployment details. Decide the UI
   for viewing and clearing overrides before shipping this behavior.
4. Reject unsupported versions and unknown fields with file paths and line
   numbers; never silently ignore a setting that a user expects to apply.
   Parse YAML as data only: no executable tags, includes, or shell-style
   interpolation. Limit file size and validate paths stay in the checkout.
5. Do not permit secrets, host mounts, Docker socket access, privileged mode,
   or server-level settings in v1. Required variables request values in the
   dashboard and use Sohwe's existing encrypted variable storage.

### Documentation deliverables

- A **five-minute first app** guide for a public repo and a private GitHub
  repo, including how to reach the generated URL and read the first build log.
- A commented `sohwe.yaml` example for a root Dockerfile, a nested Dockerfile
  in a monorepo, and a Nixpacks app. Make clear which paths are relative to
  the repository root.
- A versioned field reference and machine-readable schema for editor
  completion and validation, with an example validation command/API.
- An explicit precedence and change-management page: file vs dashboard vs
  auto-detection, how a push changes effective settings, and how to clear an
  override.
- A variables guide that distinguishes runtime and build scope and shows
  `required` keys without committing values.
- A troubleshooting page for clone, branch, Dockerfile, command, port, and
  variable failures, linked from actionable deployment errors.

Acceptance for item 5: importing a repo with a valid file requires no manual
copying of its build preferences, missing required variable values are requested
before the first deploy, and the preview identifies the source of every setting.
An invalid file blocks deployment with a specific correction. A repo without a
file continues through detection and manual setup. Existing apps retain their
current behavior until the user explicitly opts into a config path. If a later
commit adds a required variable that has no stored value, the new deployment
fails at preflight with a clear prompt while the current app stays live.

## First release acceptance criteria

Items 1–5 are implemented; validate them with the repositories below before
considering the onboarding flow accepted. An admin with a public Git URL
or an installed GitHub repository can create an app, review or change its name,
slug, branch and port, enter scoped variables, and start the first deployment
without leaving the creation flow. The deployment view opens with live logs.
Saving for later remains possible. Validation errors do not create partial apps;
if a later step fails, the UI identifies the saved app and offers a safe retry.
Existing app creation and variable APIs remain compatible.

Measure the result with a small set of real repositories: a root Dockerfile,
a Nixpacks-supported app without a Dockerfile, a private GitHub repo, and an
app requiring runtime and build variables. Record steps to first deploy,
success/failure, and where users needed manual overrides. Use those results to
shape item 4 rather than guessing at framework rules.
