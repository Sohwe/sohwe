# `sohwe.yaml` v1

Commit `sohwe.yaml` at the repository root to suggest portable preferences for one application. A monorepo can keep it at a selected relative path such as `apps/api/sohwe.yaml`. This file is separate from Sohwe's `.sohwe.json` portable backup bundle. It does not contain repository credentials, branch, slug, domain, datastore binding, or variable values.

Use the [machine-readable JSON Schema](./schemas/sohwe.v1.schema.json) for editor completion. Sohwe validates the selected branch through `POST /api/repositories/inspect` before creation; this endpoint requires an admin session and accepts `{ "gitRepo": "https://github.com/org/repo", "branch": "main", "configPath": "sohwe.yaml" }`. Its response includes `configPath`, the parsed `config`, and `resolved` values with sources. For a nested file, change `configPath` to a relative path. No file is needed: a repository without one continues through detection.

## Examples

- [Root Dockerfile](./examples/sohwe-root-dockerfile.yaml)
- [Nested Dockerfile in a monorepo](./examples/sohwe-monorepo.yaml)
- [Nixpacks app](./examples/sohwe-nixpacks.yaml)

The config path, `application.directory`, and `build.dockerfile` are all relative to the **repository root**. Selecting `apps/api` as the app directory does not narrow Docker's build context. Nixpacks also keeps the root for a detected JavaScript workspace.

## Field reference

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1`, required | Config format version. Other versions fail validation. |
| `application` | object, required | One application; multi-service Projects use their own configuration. |
| `application.name` | nonempty string, optional | Suggested display name during import only. Later pushes do not rename the app. |
| `application.directory` | relative path, optional | App source directory, defaulting to detection or `.`. |
| `application.build.mode` | `auto`, `dockerfile`, `nixpacks` | Builder preference. `auto` uses Dockerfile when present, otherwise Nixpacks. |
| `application.build.dockerfile` | relative path | Dockerfile within the checkout, interpreted from the repository root. |
| `application.build.target` | Docker stage name | Optional Docker multi-stage target. |
| `application.build.command` | string | Nixpacks build command override; requires `mode: nixpacks`. |
| `application.build.startCommand` | string | Nixpacks start command override; requires `mode: nixpacks`. |
| `application.runtime.port` | integer 1–65535 | Port the process listens on inside the container. |
| `application.runtime.command` | string | Replaces the image's container command. |
| `application.variables[]` | list | Names, scopes, `required` flags, and descriptions only. |
| `variables[].key` | environment name | Letters, digits, underscore; begins with a letter or underscore. |
| `variables[].scope` | `runtime`, `build`, `both` | Defaults to `runtime`. |
| `variables[].required` | boolean | Defaults to `false`; an absent or empty value blocks deployment. |
| `variables[].description` | string | Human-readable prompt, up to 500 characters. |

Unknown fields, duplicate variable names, unsupported versions, malformed YAML, aliases, and explicit YAML tags fail with a path and line/column. The file is limited to 64 KiB and cannot escape the checkout through a path or symlink. Dockerfile settings cannot be paired with explicit Nixpacks mode; Nixpacks commands cannot be paired with explicit Dockerfile mode. Do not put secret values, host mounts, Docker socket access, privileged mode, or server settings in this file.
Sohwe does not interpolate config fields or process includes. Build and runtime command fields are executed by the selected builder or container, so review them as executable commands.

## Precedence and later pushes

For each build and runtime setting: **dashboard override → committed file → repository detection → Sohwe default**. The import preview labels every effective setting. Changing a value in the dashboard marks it as an override for this Sohwe instance. In app **Settings**, use **Clear override** and save to let file or detection values take effect on the next deploy. Clearing the config path stops reading the file; existing apps without a selected path continue with their saved settings.

On a later deployment, the worker reads the selected config from the **exact commit it cloned**. It stores the resolved non-secret plan and commit in the deployment details. A push can change file-controlled settings, while dashboard overrides remain. If a push adds a required variable with no stored value, preflight fails before the running container is stopped; enter the value in app Variables, then retry deployment. A rollback reuses the previous image and its recorded port and command.

## Variables and image safety

Declare only names, scopes, and descriptions in Git. Sohwe prompts for required values at import and stores submitted values encrypted before starting the first deploy. `runtime` reaches only the container. `build` reaches only the image build (as Nixpacks environment or Docker build arguments); Docker may retain build inputs in image layers or history. `both` gives the same value to both stages. Keep credentials at runtime unless the build truly needs them. If an app uses an existing managed datastore binding, set that variable in Sohwe rather than committing its generated connection URL.
