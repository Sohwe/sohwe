import { createHmac, createSign, timingSafeEqual } from "node:crypto";

// GitHub App integration for Phase 5 (git-push deploys).
//
// Sohwe is self-hosted, so there is no central Sohwe GitHub App. Each instance
// creates its *own* App through GitHub's app-manifest flow: the operator POSTs
// a manifest describing the permissions Sohwe needs, GitHub creates the App and
// redirects back with a one-time code, and Sohwe exchanges that code for the
// App's id, private key, webhook secret, and client credentials. Those are
// stored encrypted with the instance key and used to mint short-lived
// installation tokens for cloning private repos.
//
// This module is deliberately dependency-free: JWTs are signed with node:crypto
// and the REST calls use global fetch, so there is no Octokit/jsonwebtoken
// footprint to keep up to date.

const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";
const USER_AGENT = "sohwe";
const API_VERSION = "2022-11-28";

/** Secrets returned by the manifest conversion; stored encrypted at rest. */
export type GitHubAppCredentials = {
  /** PEM-encoded RSA private key used to sign app JWTs. */
  pem: string;
  /** Shared secret GitHub signs webhook deliveries with. */
  webhookSecret: string;
  /** OAuth client secret. Unused today; kept so the App stays usable later. */
  clientSecret: string;
};

/** A `owner/repo` pair parsed out of a git remote URL. */
export type RepoRef = { owner: string; repo: string };

// --- URL and ref parsing ----------------------------------------------------

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const NAME_RE = /^[A-Za-z0-9._-]+$/;

function cleanRepoName(raw: string): string | null {
  const name = raw.endsWith(".git") ? raw.slice(0, -4) : raw;
  if (!name || !NAME_RE.test(name) || name === "." || name === "..") return null;
  return name;
}

/**
 * Parse `owner/repo` out of a GitHub remote URL. Accepts the https, ssh, and
 * `git@` scp-style forms. Returns null for non-GitHub hosts or malformed input,
 * which callers treat as "this app is not linked to GitHub".
 */
export function parseGitHubRepoUrl(url: string): RepoRef | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // scp-style: git@github.com:owner/repo.git
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(trimmed);
  let host: string;
  let path: string;

  if (scp?.[1] && scp[2] !== undefined) {
    host = scp[1].toLowerCase();
    path = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) {
      return null;
    }
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  }

  if (!GITHUB_HOSTS.has(host)) return null;

  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) return null;

  const owner = parts[0];
  const rawRepo = parts[1];
  if (!owner || !rawRepo) return null;
  if (!NAME_RE.test(owner)) return null;
  const repo = cleanRepoName(rawRepo);
  if (!repo) return null;

  return { owner, repo };
}

/** `owner/repo`, matching the `full_name` GitHub sends in webhook payloads. */
export function repoFullName(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/** Split a stored `owner/repo` back into a {@link RepoRef}. */
export function parseRepoFullName(fullName: string): RepoRef | null {
  const parts = fullName.split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const rawRepo = parts[1];
  if (!owner || !rawRepo || !NAME_RE.test(owner)) return null;
  const repo = cleanRepoName(rawRepo);
  if (!repo) return null;
  return { owner, repo };
}

/**
 * Branch name from a push event's `ref`. Returns null for tags and any other
 * non-branch ref, which must not trigger a branch deploy.
 */
export function branchFromRef(ref: string): string | null {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) return null;
  const branch = ref.slice(prefix.length);
  return branch.length > 0 ? branch : null;
}

// --- Webhook signature ------------------------------------------------------

/**
 * Constant-time check of GitHub's `X-Hub-Signature-256` header against the
 * **raw** request body. The body must be the exact bytes GitHub sent — a
 * re-serialized JSON object will not match.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined
): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(signatureHeader, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- App JWT ----------------------------------------------------------------

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Clock skew allowance; GitHub rejects `iat` in the future. */
const JWT_BACKDATE_SECONDS = 60;
/** GitHub caps app JWT lifetime at 10 minutes; stay just inside it. */
const JWT_LIFETIME_SECONDS = 9 * 60;

/**
 * RS256 JWT identifying the *App itself* (not an installation). Used only to
 * call `/app/*` endpoints, chiefly to mint installation tokens.
 */
export function createAppJwt(
  appId: number,
  pem: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - JWT_BACKDATE_SECONDS,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
      iss: String(appId)
    })
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(pem).toString("base64url");
  return `${signingInput}.${signature}`;
}

// --- REST plumbing ----------------------------------------------------------

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string
  ) {
    super(`GitHub API ${String(status)} on ${path}: ${message}`);
    this.name = "GitHubApiError";
  }
}

async function ghFetch(
  path: string,
  auth: string | null,
  init: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
      ...(auth ? { Authorization: auth } : {}),
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" })
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
  });

  const text = await res.text();
  if (!res.ok) {
    // Response bodies from GitHub are safe to surface (they never echo our
    // private key), but keep them short so they don't flood build logs.
    throw new GitHubApiError(res.status, path, text.slice(0, 500));
  }
  return text.length > 0 ? (JSON.parse(text) as unknown) : null;
}

// --- Installation tokens ----------------------------------------------------

export type InstallationToken = {
  token: string;
  /** Absolute expiry in epoch milliseconds. */
  expiresAt: number;
};

// Installation tokens live for an hour. Cache them per (app, installation) so a
// burst of deploys doesn't mint a token each time; refresh a minute early.
const tokenCache = new Map<string, InstallationToken>();
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Mint (or reuse) an installation access token. These are the credentials used
 * to clone private repositories and to post commit statuses. Treat the returned
 * token as a secret: never log it and never put it in an error message.
 */
export async function getInstallationToken(
  appId: number,
  pem: string,
  installationId: number
): Promise<InstallationToken> {
  const cacheKey = `${String(appId)}:${String(installationId)}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cached;
  }

  const jwt = createAppJwt(appId, pem);
  const body = (await ghFetch(
    `/app/installations/${String(installationId)}/access_tokens`,
    `Bearer ${jwt}`,
    { method: "POST" }
  )) as { token?: unknown; expires_at?: unknown } | null;

  if (!body || typeof body.token !== "string" || !body.token) {
    throw new Error("GitHub did not return an installation token");
  }
  const expiresAt =
    typeof body.expires_at === "string"
      ? Date.parse(body.expires_at)
      : Number.NaN;

  const token: InstallationToken = {
    token: body.token,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 3_600_000
  };
  tokenCache.set(cacheKey, token);
  return token;
}

/** Drop cached tokens for an app (e.g. after the installation is removed). */
export function clearInstallationTokenCache(appId?: number): void {
  if (appId === undefined) {
    tokenCache.clear();
    return;
  }
  const prefix = `${String(appId)}:`;
  for (const key of tokenCache.keys()) {
    if (key.startsWith(prefix)) tokenCache.delete(key);
  }
}

// --- App installations -----------------------------------------------------

export type AppInstallation = {
  installationId: number;
  accountLogin: string;
  accountType: "Organization" | "User";
  repositorySelection: "all" | "selected" | null;
  htmlUrl: string;
};

/** Narrow GitHub's installation response to the public metadata Sohwe stores. */
export function parseAppInstallation(value: unknown): AppInstallation | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const account = raw.account as Record<string, unknown> | null | undefined;
  const installationId = raw.id;
  const accountLogin = account?.login;
  const accountType = account?.type;
  if (
    typeof installationId !== "number" ||
    !Number.isInteger(installationId) ||
    installationId <= 0 ||
    typeof accountLogin !== "string" ||
    !accountLogin ||
    (accountType !== "Organization" && accountType !== "User")
  ) {
    return null;
  }

  const fallbackUrl =
    accountType === "Organization"
      ? `${GITHUB_WEB}/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${String(installationId)}`
      : `${GITHUB_WEB}/settings/installations/${String(installationId)}`;
  const selection = raw.repository_selection;
  return {
    installationId,
    accountLogin,
    accountType,
    repositorySelection:
      selection === "all" || selection === "selected" ? selection : null,
    htmlUrl: typeof raw.html_url === "string" ? raw.html_url : fallbackUrl
  };
}

/** Verify and describe one installation using credentials for the App itself. */
export async function getAppInstallation(
  appId: number,
  pem: string,
  installationId: number
): Promise<AppInstallation> {
  const jwt = createAppJwt(appId, pem);
  const body = await ghFetch(
    `/app/installations/${String(installationId)}`,
    `Bearer ${jwt}`
  );
  const installation = parseAppInstallation(body);
  if (!installation || installation.installationId !== installationId) {
    throw new Error("GitHub returned invalid installation metadata");
  }
  return installation;
}

/**
 * Clone URL carrying an installation token as basic-auth. **Secret** — this
 * string must never reach build logs, error messages, or the database. Pair it
 * with {@link redactSecret} when handling failures.
 */
export function tokenizedCloneUrl(ref: RepoRef, token: string): string {
  return `https://x-access-token:${token}@github.com/${ref.owner}/${ref.repo}.git`;
}

/**
 * Replace every occurrence of a secret with `***`. Git echoes the remote URL in
 * its error output, so this runs over anything derived from a failed clone.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

// --- Repositories -----------------------------------------------------------

export type InstallationRepo = {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
};

const REPO_PAGE_SIZE = 100;
/** Safety stop; 10 pages is 1000 repos, far past any self-host install. */
const REPO_MAX_PAGES = 10;

/** Every repository the installation has been granted access to. */
export async function listInstallationRepositories(
  token: string
): Promise<InstallationRepo[]> {
  const out: InstallationRepo[] = [];

  for (let page = 1; page <= REPO_MAX_PAGES; page += 1) {
    const body = (await ghFetch(
      `/installation/repositories?per_page=${String(REPO_PAGE_SIZE)}&page=${String(page)}`,
      `Bearer ${token}`
    )) as { repositories?: unknown } | null;

    const repos = Array.isArray(body?.repositories) ? body.repositories : [];
    for (const raw of repos) {
      const r = raw as Record<string, unknown>;
      const fullName = typeof r.full_name === "string" ? r.full_name : null;
      if (!fullName) continue;
      const ref = parseRepoFullName(fullName);
      out.push({
        id: typeof r.id === "number" ? r.id : 0,
        fullName,
        name: ref?.repo ?? fullName,
        owner: ref?.owner ?? "",
        private: r.private === true,
        defaultBranch:
          typeof r.default_branch === "string" ? r.default_branch : "main",
        htmlUrl:
          typeof r.html_url === "string"
            ? r.html_url
            : `${GITHUB_WEB}/${fullName}`,
        cloneUrl:
          typeof r.clone_url === "string"
            ? r.clone_url
            : `${GITHUB_WEB}/${fullName}.git`
      });
    }

    if (repos.length < REPO_PAGE_SIZE) break;
  }

  return out;
}

// --- Commit statuses --------------------------------------------------------

export type CommitStatusState = "pending" | "success" | "failure" | "error";

/**
 * Report a deploy's outcome back to the commit on GitHub. Best-effort by
 * design: the caller should swallow failures so a status-API hiccup never fails
 * an otherwise-good deploy.
 */
export async function createCommitStatus(
  token: string,
  ref: RepoRef,
  sha: string,
  status: {
    state: CommitStatusState;
    description: string;
    targetUrl?: string;
    context?: string;
  }
): Promise<void> {
  await ghFetch(
    `/repos/${ref.owner}/${ref.repo}/statuses/${sha}`,
    `Bearer ${token}`,
    {
      method: "POST",
      body: {
        state: status.state,
        // GitHub truncates at 140 characters and 422s on longer input.
        description: status.description.slice(0, 140),
        context: status.context ?? "sohwe",
        ...(status.targetUrl ? { target_url: status.targetUrl } : {})
      }
    }
  );
}

// --- App manifest flow ------------------------------------------------------

export type AppManifest = Record<string, unknown>;

/**
 * The manifest describing the App this instance wants GitHub to create.
 *
 * Permissions are the minimum for the feature set: read repository contents to
 * clone, read metadata (mandatory alongside contents), and write commit
 * statuses to report deploy results. Only `push` is subscribed.
 */
export function buildAppManifest(opts: {
  name: string;
  publicUrl: string;
  webhookPath: string;
  redirectPath: string;
  setupPath: string;
}): AppManifest {
  const base = opts.publicUrl.replace(/\/+$/, "");
  return {
    name: opts.name,
    url: base,
    hook_attributes: { url: `${base}${opts.webhookPath}`, active: true },
    redirect_url: `${base}${opts.redirectPath}`,
    setup_url: `${base}${opts.setupPath}`,
    // Re-send the operator to the setup URL when they change which repos are
    // shared, so Sohwe can refresh its cached installation id.
    setup_on_update: true,
    // "Public" here means installable by more than the owner account. Every
    // target account must still approve the App and choose repository access;
    // it does not expose repositories or publish the App in Marketplace.
    public: true,
    default_permissions: {
      contents: "read",
      metadata: "read",
      statuses: "write"
    },
    default_events: ["push"]
  };
}

/** Where the browser POSTs the manifest. Org-owned Apps use a different path. */
export function manifestCreateUrl(state: string, organization?: string): string {
  const query = `?state=${encodeURIComponent(state)}`;
  return organization
    ? `${GITHUB_WEB}/organizations/${encodeURIComponent(organization)}/settings/apps/new${query}`
    : `${GITHUB_WEB}/settings/apps/new${query}`;
}

/** Page the operator visits to install a created App on their account/org. */
export function appInstallUrl(slug: string): string {
  return `${GITHUB_WEB}/apps/${slug}/installations/new`;
}

export type ManifestConversion = {
  appId: number;
  slug: string;
  name: string;
  clientId: string;
  htmlUrl: string;
  owner: string | null;
  credentials: GitHubAppCredentials;
};

/**
 * Exchange the one-time manifest code for the new App's credentials. The code
 * is single-use and expires after an hour.
 */
export async function convertAppManifest(
  code: string
): Promise<ManifestConversion> {
  const body = (await ghFetch(
    `/app-manifests/${encodeURIComponent(code)}/conversions`,
    // This endpoint is the one App API call that takes no authentication: the
    // single-use code *is* the credential.
    null,
    { method: "POST" }
  )) as Record<string, unknown> | null;

  if (!body) throw new Error("GitHub returned an empty manifest conversion");

  const appId = typeof body.id === "number" ? body.id : Number.NaN;
  const pem = typeof body.pem === "string" ? body.pem : "";
  const webhookSecret =
    typeof body.webhook_secret === "string" ? body.webhook_secret : "";

  if (!Number.isInteger(appId) || !pem || !webhookSecret) {
    throw new Error(
      "GitHub manifest conversion is missing the app id, private key, or webhook secret"
    );
  }

  const owner = body.owner as { login?: unknown } | undefined;
  const slug = typeof body.slug === "string" ? body.slug : "";

  return {
    appId,
    slug,
    name: typeof body.name === "string" ? body.name : slug,
    clientId: typeof body.client_id === "string" ? body.client_id : "",
    htmlUrl:
      typeof body.html_url === "string"
        ? body.html_url
        : `${GITHUB_WEB}/apps/${slug}`,
    owner: typeof owner?.login === "string" ? owner.login : null,
    credentials: {
      pem,
      webhookSecret,
      clientSecret:
        typeof body.client_secret === "string" ? body.client_secret : ""
    }
  };
}

// --- Push event -------------------------------------------------------------

export type PushEvent = {
  repoFullName: string;
  branch: string;
  headSha: string;
  headMessage: string | null;
  /** True for branch deletions, which must not trigger a deploy. */
  deleted: boolean;
};

/**
 * Narrow a raw `push` payload to the fields Sohwe acts on. Returns null when
 * the payload is not a usable branch push (tag push, malformed body, or a
 * zero-sha branch deletion).
 */
export function parsePushEvent(payload: unknown): PushEvent | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  const repo = p.repository as { full_name?: unknown } | undefined;
  const fullName = typeof repo?.full_name === "string" ? repo.full_name : null;
  if (!fullName) return null;

  const ref = typeof p.ref === "string" ? p.ref : "";
  const branch = branchFromRef(ref);
  if (!branch) return null;

  const after = typeof p.after === "string" ? p.after : "";
  const deleted = p.deleted === true || /^0+$/.test(after);

  const headCommit = p.head_commit as { message?: unknown } | null | undefined;
  const headMessage =
    typeof headCommit?.message === "string"
      ? (headCommit.message.split("\n")[0]?.trim() ?? null)
      : null;

  return {
    repoFullName: fullName,
    branch,
    headSha: after,
    headMessage,
    deleted
  };
}
