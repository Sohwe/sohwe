import {
  createCommitStatus,
  parseRepoFullName,
  redactSecret,
  tokenizedCloneUrl,
  type CommitStatusState,
  type RepoRef
} from "@sohwe/github";
import { getOrgInstallationToken } from "@sohwe/github/resolve";

// GitHub-aware deploy support (Phase 5): clone private repositories with a
// short-lived installation token, and report the deploy outcome back to the
// commit.
//
// Everything here is best-effort. An app whose repo is public, or whose org has
// no App installed, deploys exactly as before — `resolveGitHubContext` returns
// null and the caller falls back to an anonymous clone.

export type GitHubDeployContext = {
  ref: RepoRef;
  /** Installation access token. Secret: never log or persist. */
  token: string;
  /** Clone URL with the token embedded. Secret for the same reason. */
  cloneUrl: string;
};

/**
 * Credentials for cloning this app's repository, or null when the app isn't
 * linked to a connected GitHub App installation.
 */
export async function resolveGitHubContext(app: {
  organizationId: string;
  repoFullName: string | null;
}): Promise<GitHubDeployContext | null> {
  if (!app.repoFullName) return null;
  const ref = parseRepoFullName(app.repoFullName);
  if (!ref) return null;

  const resolved = await getOrgInstallationToken(app.organizationId);
  if (!resolved) return null;

  return {
    ref,
    token: resolved.token.token,
    cloneUrl: tokenizedCloneUrl(ref, resolved.token.token)
  };
}

/**
 * Strip an installation token out of text bound for a build log, the database,
 * or an alert. Git echoes the remote URL in its error output, so any message
 * derived from a failed clone passes through here first.
 */
export function redactDeployError(
  message: string,
  ctx: GitHubDeployContext | null
): string {
  return ctx ? redactSecret(message, ctx.token) : message;
}

function deploymentUrl(applicationId: string, deploymentId: string): string | undefined {
  const base = process.env.SOHWE_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!base) return undefined;
  return `${base}/apps/${applicationId}/deployments/${deploymentId}`;
}

/**
 * Post a commit status. Swallows every failure: a status-API hiccup, a revoked
 * installation, or a missing `statuses: write` grant must never fail a deploy
 * that is otherwise fine.
 */
export async function reportCommitStatus(
  ctx: GitHubDeployContext | null,
  args: {
    commitSha: string | null;
    state: CommitStatusState;
    description: string;
    applicationId: string;
    deploymentId: string;
  }
): Promise<void> {
  if (!ctx || !args.commitSha) return;
  try {
    await createCommitStatus(ctx.token, ctx.ref, args.commitSha, {
      state: args.state,
      description: args.description,
      targetUrl: deploymentUrl(args.applicationId, args.deploymentId)
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `Failed to report commit status to GitHub: ${redactDeployError(msg, ctx)}`
    );
  }
}
