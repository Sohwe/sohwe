import { decryptJson } from "@sohwe/crypto";
import { prisma } from "@sohwe/db";
import {
  getInstallationToken,
  type GitHubAppCredentials,
  type InstallationToken
} from "./index";

// Database-aware helpers, kept out of `./index` so the core stays dependency-
// free and unit-testable. Both the API (repo listing) and the worker (private
// clones, commit statuses) need to go from an organization id to a usable
// installation token, so that walk lives here rather than being duplicated.

export type ResolvedGitHubApp = {
  id: string;
  organizationId: string;
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  ownerLogin: string | null;
  installationId: number | null;
  installedAt: Date | null;
  credentials: GitHubAppCredentials;
};

/**
 * Decrypt the stored `{ pem, webhookSecret, clientSecret }` blob. Throws if the
 * instance key no longer matches what encrypted it, which is the honest
 * outcome — the app has to be reconnected.
 */
export function decryptAppCredentials(buf: Buffer): GitHubAppCredentials {
  const obj = decryptJson(buf);
  const pem = obj.pem ?? "";
  const webhookSecret = obj.webhookSecret ?? "";
  if (!pem || !webhookSecret) {
    throw new Error(
      "Stored GitHub App credentials are missing the private key or webhook secret"
    );
  }
  return { pem, webhookSecret, clientSecret: obj.clientSecret ?? "" };
}

function toResolved(row: {
  id: string;
  organizationId: string;
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  ownerLogin: string | null;
  installationId: number | null;
  installedAt: Date | null;
  credentialsEncrypted: Buffer;
}): ResolvedGitHubApp {
  return {
    id: row.id,
    organizationId: row.organizationId,
    appId: row.appId,
    slug: row.slug,
    name: row.name,
    htmlUrl: row.htmlUrl,
    ownerLogin: row.ownerLogin,
    installationId: row.installationId,
    installedAt: row.installedAt,
    credentials: decryptAppCredentials(row.credentialsEncrypted)
  };
}

/** The organization's connected App, with credentials decrypted. */
export async function loadGitHubApp(
  organizationId: string
): Promise<ResolvedGitHubApp | null> {
  const row = await prisma.gitHubApp.findUnique({ where: { organizationId } });
  return row ? toResolved(row) : null;
}

/**
 * Look up an App by its GitHub-assigned numeric id. Used by the webhook, where
 * the delivery identifies the app but not the Sohwe organization.
 */
export async function loadGitHubAppByAppId(
  appId: number
): Promise<ResolvedGitHubApp | null> {
  const row = await prisma.gitHubApp.findFirst({ where: { appId } });
  return row ? toResolved(row) : null;
}

export type OrgInstallationToken = {
  app: ResolvedGitHubApp;
  token: InstallationToken;
};

/**
 * Installation token for an organization, or null when no App is connected or
 * it has not been installed on an account yet. Callers treat null as "fall back
 * to an unauthenticated clone", which is correct for public repositories.
 */
export async function getOrgInstallationToken(
  organizationId: string
): Promise<OrgInstallationToken | null> {
  const app = await loadGitHubApp(organizationId);
  if (!app?.installationId) return null;
  const token = await getInstallationToken(
    app.appId,
    app.credentials.pem,
    app.installationId
  );
  return { app, token };
}
