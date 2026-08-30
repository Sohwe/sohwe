import { decryptJson } from "@sohwe/crypto";
import { prisma } from "@sohwe/db";
import {
  getInstallationToken,
  type GitHubAppCredentials,
  type InstallationToken,
  type RepoRef
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
  multiAccount: boolean;
  installations: ResolvedGitHubInstallation[];
  credentials: GitHubAppCredentials;
};

export type ResolvedGitHubInstallation = {
  id: string;
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  repositorySelection: string | null;
  htmlUrl: string | null;
  installedAt: Date;
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
  multiAccount: boolean;
  installations: ResolvedGitHubInstallation[];
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
    multiAccount: row.multiAccount,
    installations: row.installations,
    credentials: decryptAppCredentials(row.credentialsEncrypted)
  };
}

/** The organization's connected App, with credentials decrypted. */
export async function loadGitHubApp(
  organizationId: string
): Promise<ResolvedGitHubApp | null> {
  const row = await prisma.gitHubApp.findUnique({
    where: { organizationId },
    include: { installations: { orderBy: { accountLogin: "asc" } } }
  });
  return row ? toResolved(row) : null;
}

/**
 * Look up an App by its GitHub-assigned numeric id. Used by the webhook, where
 * the delivery identifies the app but not the Sohwe organization.
 */
export async function loadGitHubAppByAppId(
  appId: number
): Promise<ResolvedGitHubApp | null> {
  const row = await prisma.gitHubApp.findFirst({
    where: { appId },
    include: { installations: { orderBy: { accountLogin: "asc" } } }
  });
  return row ? toResolved(row) : null;
}

export type OrgInstallationToken = {
  app: ResolvedGitHubApp;
  installation: ResolvedGitHubInstallation;
  token: InstallationToken;
};

/**
 * Installation tokens for every GitHub account connected to a Sohwe
 * organization. Repository listing uses all of them.
 */
export async function getOrgInstallationTokens(
  organizationId: string
): Promise<OrgInstallationToken[]> {
  const app = await loadGitHubApp(organizationId);
  if (!app) return [];
  return Promise.all(
    app.installations.map(async (installation) => ({
      app,
      installation,
      token: await getInstallationToken(
        app.appId,
        app.credentials.pem,
        installation.installationId
      )
    }))
  );
}

/** Installation token whose account owns `ref`, for clone and status calls. */
export async function getRepoInstallationToken(
  organizationId: string,
  ref: RepoRef
): Promise<OrgInstallationToken | null> {
  const app = await loadGitHubApp(organizationId);
  if (!app || app.installations.length === 0) return null;

  const owner = ref.owner.toLowerCase();
  const installation =
    app.installations.find(
      (item) => item.accountLogin?.toLowerCase() === owner
    ) ??
    // A migrated pre-multi-account row has no account metadata. Preserve its
    // old behavior until its next setup callback fills the metadata in.
    (app.installations.length === 1 && !app.installations[0]?.accountLogin
      ? app.installations[0]
      : undefined);
  if (!installation) return null;

  const token = await getInstallationToken(
    app.appId,
    app.credentials.pem,
    installation.installationId
  );
  return { app, installation, token };
}
