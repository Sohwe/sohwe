# Deployment troubleshooting

Open the app's **Deployments** tab, select the failed deployment, and read the error and build log. For config-backed apps, the drawer shows the config path, commit, resolved settings, and their sources. Correct the file on the tracked branch or change the named setting in Sohwe, then deploy again.

| Symptom | Check and correction |
| --- | --- |
| Repository cannot be inspected or cloned | Confirm the HTTPS URL. For a private GitHub repo, check that the connected GitHub App has access to that repository. Reopen **Git** to adjust its installation if needed. |
| Branch not found | Pick a branch from the dropdown or enter its exact name. Confirm the tracked branch in app **Settings**. |
| `sohwe.yaml` error with line and column | Open that path at the reported commit. Fix the named field or syntax; unsupported versions and unknown keys block import/deploy. |
| Dockerfile missing | Check the resolved Dockerfile path in the build plan. Paths start at the repository root, even when the app directory is nested. Set the Dockerfile override or correct the file. |
| Nixpacks cannot start the app | Confirm the detected or configured start command. Set `application.build.startCommand` in `sohwe.yaml` or override it in app **Settings**. For Dockerfile builds, check `CMD`/`ENTRYPOINT` or the container command override. |
| Container starts but URL does not work | Confirm the process listens on `0.0.0.0` and on the resolved container port, not only on localhost. Adjust `application.runtime.port` or the dashboard port override. |
| Required variable missing | Add the named value in app **Variables** with the scope declared in `sohwe.yaml`. Build-only and runtime-only are different stores; `both` must be available in both. Retry after saving. |

If the new deployment fails before promotion, inspect the current deployment and runtime logs as well. A missing required variable is detected before Sohwe replaces the running container.
