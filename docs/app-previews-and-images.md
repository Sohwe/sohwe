# Branch previews and public image applications

## Preview a Git branch

Open a Git application's **Overview** and choose **Create preview**. Select or enter a branch, inspect it, and enter the variable values it needs. Sohwe creates a separate preview application with its own generated URL, container, network, logs, and deployment history. The current application stays running while the preview builds or fails.

The preview copies non-secret build and runtime settings from the source application, including its `sohwe.yaml` path and dashboard overrides. It does **not** copy runtime variables, build variables, volumes, datastore bindings, custom domains, or push-to-deploy. Required keys from the preview branch's `sohwe.yaml` are shown during setup; supply their values in the preview form. The values are encrypted before its first deploy is requested.

Previews are manual branch deployments. Sohwe does not create them from pull request events or delete them when a pull request closes. Delete a preview from its **Settings** when finished. Deleting the source application also deletes its previews and their Docker resources. Portable configuration bundles exclude previews.

## Import a public container image

Open **Applications → Import image**. Enter a public registry reference such as `nginx:1.27` or `ghcr.io/acme/web:1.0.0`, a name, slug, and the port the process listens on. Add runtime variables if needed, then choose **Create and deploy** or **Save for later**. Image apps have the same URL, logs, domains, resource limits, runtime variables, and rollback flow as Git apps. There is no Git branch, repository config, build step, or push-to-deploy setting.

The worker pulls the image on each new deployment and records its local immutable image ID for that deployment. A later pull of a moving tag can produce a different image; pin a `sha256` digest when you need reproducible deployments. Rollback reuses the locally recorded image ID, so retain that image on the host if rollback is important. Sohwe does not currently accept registry credentials: the image must be publicly pullable. Never embed a username, password, or token in an image reference. The UI and API accept runtime variables only for image apps, because there is no image build to receive build variables.

Portable bundles preserve the public image reference in format v9. Older bundles remain readable and restore as Git applications. Bundles carry configuration, not image layers or volume data.
