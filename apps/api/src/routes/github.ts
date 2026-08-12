import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { encryptJson } from "@sohwe/crypto";
import { prisma } from "@sohwe/db";
import {
  appInstallUrl,
  buildAppManifest,
  clearInstallationTokenCache,
  convertAppManifest,
  createAppJwt,
  listInstallationRepositories,
  manifestCreateUrl,
  parseGitHubRepoUrl,
  repoFullName
} from "@sohwe/github";
import {
  getOrgInstallationToken,
  loadGitHubApp
} from "@sohwe/github/resolve";
import { z } from "zod";
import type { ApiConfig } from "../env";
import { recordAudit } from "../audit";
import { publicBaseUrl } from "../public-url";
import { requireRole } from "../rbac";

// Admin-and-above. Connecting or forgetting the App changes how every repo in
// the org deploys, and the connection detail is operator configuration.

// GitHub App connection flow (Phase 5).
//
// Sohwe never ships a central GitHub App: each instance creates its own through
// GitHub's app-manifest flow, so the operator keeps ownership of the App, its
// private key, and its webhook secret. The flow is three browser hops:
//
//   1. GET  /api/github/manifest/new       -> auto-submitting form to GitHub
//   2. GET  /api/github/manifest/callback  -> exchange code, store credentials
//   3. GET  /api/github/setup/callback     -> record the installation id
//
// Steps 2 and 3 are top-level GET navigations initiated by GitHub. The session
// cookie is SameSite=Lax, so it rides along and the routes can stay authed.

export const GITHUB_WEBHOOK_PATH = "/api/webhooks/github";
const MANIFEST_REDIRECT_PATH = "/api/github/manifest/callback";
const SETUP_REDIRECT_PATH = "/api/github/setup/callback";

/** Where to send the browser once a hop completes (relative: same origin). */
const DASHBOARD_GIT_PATH = "/git";

/** GitHub rejects App names longer than this. */
const MAX_APP_NAME = 34;

const STATE_TTL_MS = 15 * 60 * 1000;

// --- CSRF state -------------------------------------------------------------

/**
 * Signed, expiring state parameter. GitHub echoes it back on the manifest
 * callback; verifying it means the callback belongs to a flow this instance
 * actually started, for this organization.
 */
function signState(secret: string, organizationId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ o: organizationId, t: Date.now() }),
    "utf8"
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyState(secret: string, raw: string | undefined): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as { o?: unknown; t?: unknown };
    if (typeof data.o !== "string" || typeof data.t !== "number") return null;
    const age = Date.now() - data.t;
    if (age < 0 || age > STATE_TTL_MS) return null;
    return data.o;
  } catch {
    return null;
  }
}

// --- Helpers ----------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function defaultAppName(baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    // keep the raw value; it is only a display default
  }
  return `Sohwe ${host}`.slice(0, MAX_APP_NAME);
}

const ManifestNewQuery = z.object({
  /** GitHub organization login to create the App under; omitted = personal. */
  org: z.string().max(100).optional(),
  name: z.string().min(1).max(MAX_APP_NAME).optional()
});

const ManifestCallbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1).optional()
});

const DeliveriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const SetupCallbackQuery = z.object({
  installation_id: z.coerce.number().int().positive().optional(),
  setup_action: z.string().max(50).optional()
});

/**
 * Populate `repoFullName` for apps created before Phase 5. Only rows where it
 * is still null are touched, so this settles to a no-op after the first boot
 * (apps on non-GitHub remotes stay null, which is correct — they can't receive
 * webhooks). Failures are logged and ignored; the column is an optimization.
 */
export async function backfillRepoFullNames(log: {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}): Promise<void> {
  try {
    const rows = await prisma.application.findMany({
      where: { repoFullName: null },
      select: { id: true, gitRepo: true }
    });

    let filled = 0;
    for (const row of rows) {
      const ref = parseGitHubRepoUrl(row.gitRepo);
      if (!ref) continue;
      await prisma.application.update({
        where: { id: row.id },
        data: { repoFullName: repoFullName(ref) }
      });
      filled += 1;
    }
    if (filled > 0) log.info({ filled }, "Backfilled GitHub repo names");
  } catch (err) {
    log.warn({ err }, "Backfill of application repo names failed");
  }
}

export async function registerGitHubRoutes(
  app: FastifyInstance,
  config: ApiConfig
) {
  /** Connection status for the dashboard. Never returns any secret material. */
  app.get(
    "/api/github/app",
    { preHandler: [requireRole("admin")] },
    async (req) => {
      const u = req.user!;
      const row = await prisma.gitHubApp.findUnique({
        where: { organizationId: u.organizationId },
        select: {
          appId: true,
          slug: true,
          name: true,
          htmlUrl: true,
          ownerLogin: true,
          installationId: true,
          installedAt: true,
          createdAt: true
        }
      });

      const baseUrl = publicBaseUrl(req, config);
      return {
        connected: row !== null,
        publicUrl: baseUrl,
        // The dashboard warns when this is a guess: a wrong origin bakes an
        // unreachable webhook URL into the App at creation time.
        publicUrlConfigured: config.publicUrl !== null,
        webhookUrl: `${baseUrl}${GITHUB_WEBHOOK_PATH}`,
        app: row
          ? {
              appId: row.appId,
              slug: row.slug,
              name: row.name,
              htmlUrl: row.htmlUrl,
              ownerLogin: row.ownerLogin,
              installed: row.installationId !== null,
              installationId: row.installationId,
              installedAt: row.installedAt,
              createdAt: row.createdAt,
              installUrl: appInstallUrl(row.slug)
            }
          : null
      };
    }
  );

  /**
   * Step 1. GitHub's manifest flow requires a form POST from the browser, so
   * this returns a tiny self-submitting page rather than a redirect.
   */
  app.get(
    "/api/github/manifest/new",
    { preHandler: [requireRole("admin")], schema: { querystring: ManifestNewQuery } },
    async (req, reply) => {
      const u = req.user!;
      const { org, name } = ManifestNewQuery.parse(req.query);

      const existing = await prisma.gitHubApp.findUnique({
        where: { organizationId: u.organizationId },
        select: { id: true }
      });
      if (existing) {
        return reply.conflict(
          "A GitHub App is already connected. Disconnect it before creating another."
        );
      }

      const baseUrl = publicBaseUrl(req, config);
      const manifest = buildAppManifest({
        name: name ?? defaultAppName(baseUrl),
        publicUrl: baseUrl,
        webhookPath: GITHUB_WEBHOOK_PATH,
        redirectPath: MANIFEST_REDIRECT_PATH,
        setupPath: SETUP_REDIRECT_PATH
      });

      const state = signState(config.sessionSecret, u.organizationId);
      const action = manifestCreateUrl(state, org);
      const payload = escapeHtml(JSON.stringify(manifest));

      return reply
        .type("text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .send(
          `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Creating GitHub App…</title></head>
<body>
<p>Redirecting to GitHub to create the app…</p>
<form id="f" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${payload}">
<noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("f").submit();</script>
</body>
</html>`
        );
    }
  );

  /**
   * Step 2. GitHub redirects here with a single-use code. Exchanging it yields
   * the App's id, private key, and webhook secret, which are stored encrypted.
   */
  app.get(
    "/api/github/manifest/callback",
    {
      preHandler: [requireRole("admin")],
      schema: { querystring: ManifestCallbackQuery }
    },
    async (req, reply) => {
      const u = req.user!;
      const { code, state } = ManifestCallbackQuery.parse(req.query);

      const stateOrg = verifyState(config.sessionSecret, state);
      if (stateOrg === null || stateOrg !== u.organizationId) {
        return reply.badRequest(
          "This GitHub App setup link is invalid or has expired. Start again from the Git settings page."
        );
      }

      const existing = await prisma.gitHubApp.findUnique({
        where: { organizationId: u.organizationId },
        select: { id: true }
      });
      if (existing) {
        return reply.conflict("A GitHub App is already connected.");
      }

      const conversion = await convertAppManifest(code);

      await prisma.gitHubApp.create({
        data: {
          organizationId: u.organizationId,
          appId: conversion.appId,
          slug: conversion.slug,
          name: conversion.name,
          clientId: conversion.clientId,
          htmlUrl: conversion.htmlUrl,
          ownerLogin: conversion.owner,
          credentialsEncrypted: encryptJson({
            pem: conversion.credentials.pem,
            webhookSecret: conversion.credentials.webhookSecret,
            clientSecret: conversion.credentials.clientSecret
          })
        }
      });

      await recordAudit(req, {
        action: "github.connect",
        targetType: "github",
        targetLabel: conversion.slug,
        // Public App identity only — never the PEM, webhook secret, or client secret.
        metadata: { appId: conversion.appId, ownerLogin: conversion.owner }
      });

      // Straight on to installation; an App with no installation can't do
      // anything yet, so there is no useful intermediate state to show.
      return reply.redirect(appInstallUrl(conversion.slug));
    }
  );

  /**
   * Step 3. GitHub sends the operator here after they choose which repositories
   * to share. The installation id arrives as a query parameter, so it is
   * verified against the App before being trusted.
   */
  app.get(
    "/api/github/setup/callback",
    {
      preHandler: [requireRole("admin")],
      schema: { querystring: SetupCallbackQuery }
    },
    async (req, reply) => {
      const u = req.user!;
      const query = SetupCallbackQuery.parse(req.query);
      const installationId = query.installation_id;

      const connected = await loadGitHubApp(u.organizationId);
      if (!connected) {
        return reply.redirect(`${DASHBOARD_GIT_PATH}?error=not_connected`);
      }
      if (installationId === undefined) {
        // `setup_action=request` means the operator asked an org owner to
        // approve; there is nothing to record yet.
        return reply.redirect(`${DASHBOARD_GIT_PATH}?pending=1`);
      }

      // Confirm the installation actually belongs to this App before storing
      // it, so a crafted link can't point the instance at someone else's.
      const jwt = createAppJwt(connected.appId, connected.credentials.pem);
      const res = await fetch(
        `https://api.github.com/app/installations/${String(installationId)}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "sohwe",
            Authorization: `Bearer ${jwt}`
          }
        }
      );
      if (!res.ok) {
        req.log.warn(
          { status: res.status, installationId },
          "Rejected GitHub setup callback: installation does not belong to this app"
        );
        return reply.redirect(`${DASHBOARD_GIT_PATH}?error=bad_installation`);
      }

      await prisma.gitHubApp.update({
        where: { organizationId: u.organizationId },
        data: { installationId, installedAt: new Date() }
      });
      clearInstallationTokenCache(connected.appId);

      return reply.redirect(`${DASHBOARD_GIT_PATH}?installed=1`);
    }
  );

  /** Repositories the installation can see, for the app-create repo picker. */
  app.get(
    "/api/github/repositories",
    { preHandler: [requireRole("admin")] },
    async (req, reply) => {
      const u = req.user!;
      const resolved = await getOrgInstallationToken(u.organizationId);
      if (!resolved) {
        return reply.badRequest(
          "No GitHub App is installed for this organization."
        );
      }
      const repositories = await listInstallationRepositories(
        resolved.token.token
      );
      return { repositories };
    }
  );

  /**
   * Recent inbound webhook deliveries, for diagnosing a push that did not
   * deploy.
   *
   * Rejected deliveries have no organization — the payload naming one is
   * unverified — so they are returned alongside this org's rows. That is safe
   * because a rejected row stores nothing but GitHub's clear-text headers and
   * an outcome, and it is the whole point of the view: a wrong webhook secret
   * would otherwise show up as complete silence.
   */
  app.get(
    "/api/github/deliveries",
    {
      preHandler: [requireRole("admin")],
      schema: { querystring: DeliveriesQuery }
    },
    async (req) => {
      const u = req.user!;
      const { limit } = DeliveriesQuery.parse(req.query);
      const deliveries = await prisma.webhookDelivery.findMany({
        where: {
          OR: [{ organizationId: u.organizationId }, { organizationId: null }]
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          deliveryId: true,
          event: true,
          verified: true,
          outcome: true,
          detail: true,
          repoFullName: true,
          branch: true,
          commitSha: true,
          deployCount: true,
          createdAt: true
        }
      });
      return { deliveries };
    }
  );

  /**
   * Forget the App locally. This cannot delete the App on GitHub — the operator
   * owns it — so the response says what is left to clean up by hand.
   */
  app.delete(
    "/api/github/app",
    { preHandler: [requireRole("admin")] },
    async (req, reply) => {
      const u = req.user!;
      const row = await prisma.gitHubApp.findUnique({
        where: { organizationId: u.organizationId },
        select: { appId: true, htmlUrl: true }
      });
      if (!row) return reply.notFound();

      await prisma.$transaction([
        // Push deploys stop working, so don't leave apps claiming otherwise.
        prisma.application.updateMany({
          where: { organizationId: u.organizationId, autoDeploy: true },
          data: { autoDeploy: false }
        }),
        prisma.gitHubApp.delete({ where: { organizationId: u.organizationId } })
      ]);
      clearInstallationTokenCache(row.appId);

      await recordAudit(req, {
        action: "github.disconnect",
        targetType: "github",
        metadata: { appId: row.appId }
      });
      return { ok: true, deleteAppUrl: `${row.htmlUrl}/advanced` };
    }
  );
}
