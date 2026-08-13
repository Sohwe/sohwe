# Phase 3.5 — VPS smoke test checklist

These three checks are the only open Phase 3.5 items. They must be run on a real
fresh Ubuntu VPS (they exercise the installer, Docker, Traefik routing, and the
host `sohwe` CLI), so they can't be done from a dev laptop or CI. Run them after
any installer or base-domain change.

Prereqs: a clean Ubuntu 22.04/24.04 host, a DNS A record (or wildcard) pointing at
the box if you want to test a real domain, and `root`/`sudo`.

## 1. Fresh-Ubuntu install smoke test

```bash
# On the fresh VPS:
curl -fsSL https://raw.githubusercontent.com/Sohwe/sohwe/main/scripts/install.sh | sudo bash
```

Or, when testing unreleased code, from a clone (the installer then uses the
checkout's compose files and `sohwe` CLI instead of fetching from `main`):

```bash
git clone https://github.com/Sohwe/sohwe.git && cd sohwe
sudo SOHWE_VERSION=dev bash scripts/install.sh   # dev = images published via workflow_dispatch
```

- [ ] Installer prompts for (or accepts via env) `SOHWE_BASE_DOMAIN` and writes it to
      `/etc/sohwe/sohwe.env`.
- [ ] With a domain configured, the installer prints the DNS records to create
      (dashboard A + apps wildcard, with the server's public IP) and verifies
      them, including the wildcard via a random label; skipping is possible and
      never blocks the install.
- [ ] The installer waits for the dashboard to respond before printing the
      final banner and next steps.
- [ ] `sohwe` CLI is installed on the host (`which sohwe`).
- [ ] `sohwe status` (or `docker compose ps`) shows api, worker, dashboard, postgres,
      redis, and traefik all healthy.
- [ ] Dashboard loads over HTTP at the configured host; the first-run unlock +
      owner-setup flow completes (this is the cookie path fixed in v0.3.8 — confirm
      you are not bounced back to the unlock screen).
- [ ] Create an app from a public Git repo, deploy it, and confirm:
  - [ ] Build logs stream live in the deployment view.
  - [ ] The app responds at `http://<slug>.<SOHWE_BASE_DOMAIN>` via Traefik.
  - [ ] Add an env var to the app, redeploy, and confirm the app sees it —
        this proves the generated `SOHWE_ENCRYPTION_KEY` is usable end-to-end
        (the gap that hid the pre-v0.6.0 hex-key bug).
  - [ ] **Logs** tab streams runtime output.
  - [ ] **Metrics** tab shows live CPU/memory.
  - [ ] (Optional) Add a Slack/Discord/generic webhook under Settings → Crash
        alerts, `docker kill` the app container, and confirm the webhook fires and
        the app shows `crashed`.

## 2. Confirm `sohwe update` on a real VPS

Start from an instance installed at the previous released version, then:

```bash
sudo sohwe update          # or: sudo sohwe update <version>
```

- [ ] Pulls the new GHCR images.
- [ ] Runs `sohwe migrate` (currently `prisma db push`) without data loss — confirm
      the new `alert_destinations` table exists (`sohwe` apps and their settings
      survive the update).
- [ ] All services come back healthy.
- [ ] Existing apps still serve traffic and their data/volumes are intact.

## 3. Confirm rollback after a deploy

Within an app that has at least two successful deployments:

- [ ] Deployments tab lists prior successful builds with a promote/rollback action.
- [ ] Rolling back to a previous deployment reuses that image (no rebuild), the app
      comes back healthy, and the "current" marker moves to the rolled-back
      deployment.
- [ ] Note: `sohwe rollback` (host CLI) intentionally does **not** run migrations.

Tick each box as you go; once all three sections pass, mark the corresponding
Phase 3.5 items complete in `ROADMAP.md`.
