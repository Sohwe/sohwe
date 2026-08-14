export type SetupStatus = {
  needsSetup: boolean;
  /** True when SOHWE_SETUP_PASSWORD is set and no users exist yet. */
  setupGateActive: boolean;
  /** True when the browser holds a valid unlock cookie. */
  setupUnlocked: boolean;
};

export type Me = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  organization: { id: string; name: string };
};

export type AppVolume = {
  id: string;
  mountPath: string;
  sizeBytes: string | null;
  createdAt: string;
};

export type AppRow = {
  id: string;
  name: string;
  slug: string;
  gitRepo: string;
  gitBranch: string;
  /** `owner/repo` when the remote is GitHub; null otherwise. */
  repoFullName: string | null;
  /** Deploy on every push to `gitBranch`. */
  autoDeploy: boolean;
  port: number;
  status: string;
  buildMode: string;
  buildCmd: string | null;
  startCmd: string | null;
  domain: string | null;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  createdAt: string;
  volumes?: AppVolume[];
  deployments?: {
    id: string;
    status: string;
    imageTag: string | null;
    commitSha: string | null;
    commitMessage: string | null;
    /** manual | push | rollback */
    trigger: string;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }[];
};

export function getCurrentDeploymentId(
  deployments: AppRow["deployments"] | undefined
): string | null {
  if (!deployments?.length) return null;
  const sorted = [...deployments].sort(
    (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)
  );
  for (const d of sorted) {
    if (d.status === "success" && d.imageTag) return d.id;
  }
  return null;
}

export type BuildMode = "auto" | "dockerfile" | "nixpacks";

export type AppStats =
  | { running: false }
  | {
      running: true;
      cpuPercent: number;
      memUsedBytes: number;
      memLimitBytes: number;
      memPercent: number;
      ts: number;
    };

export type AlertDestinationType = "discord" | "slack" | "generic";

export type AlertDestination = {
  id: string;
  type: AlertDestinationType;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type S3DestinationConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  prefix?: string;
  forcePathStyle?: boolean;
};

export type BackupDestination = {
  id: string;
  name: string;
  kind: "local" | "s3";
  /** `{ path }` for local; S3 config (no credentials) for s3. */
  config: { path: string } | S3DestinationConfig;
  createdAt: string;
  updatedAt: string;
};

export type BundleRecord = {
  id: string;
  destinationId: string | null;
  scheduleId: string | null;
  filename: string;
  sizeBytes: string | null;
  appCount: number;
  includesSecrets: boolean;
  status: string;
  errorMessage: string | null;
  createdAt: string;
};

/** Short, non-sensitive summary of a destination's target for list/select UI. */
export function describeDestinationConfig(d: BackupDestination): string {
  if (d.kind === "s3") {
    const c = d.config as S3DestinationConfig;
    const prefix = c.prefix ? `/${c.prefix.replace(/^\/+|\/+$/g, "")}` : "";
    return `s3://${c.bucket}${prefix}`;
  }
  return (d.config as { path: string }).path;
}

export type BackupSchedule = {
  id: string;
  destinationId: string;
  destinationName: string | null;
  destinationKind: string | null;
  cron: string;
  enabled: boolean;
  includeSecrets: boolean;
  retentionCount: number | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SlugCollisionPolicy = "rename" | "overwrite" | "skip";

export type RestorePreflightApp = {
  name: string;
  slug: string;
  collides: boolean;
  volumeCount: number;
  alertCount: number;
  envKeyCount: number;
};

export type RestorePreflightDatastore = {
  name: string;
  slug: string;
  kind: string;
  engineVersion: string;
  collides: boolean;
  bindingCount: number;
};

export type RestorePreflight = {
  sourceOrgName: string;
  createdAt: string;
  includesSecrets: boolean;
  apps: RestorePreflightApp[];
  datastores: RestorePreflightDatastore[];
};

export type RestoreResult = {
  created: number;
  overwritten: number;
  skipped: number;
  renamed: number;
  datastoresCreated: number;
  datastoresOverwritten: number;
  datastoresSkipped: number;
  datastoresRenamed: number;
  bindingsRestored: number;
  bindingsDropped: number;
};

/** Connection state of this instance's GitHub App. Never carries secrets. */
export type GitHubAppStatus = {
  connected: boolean;
  /** Origin used to build the app manifest's webhook and redirect URLs. */
  publicUrl: string;
  /** False when `publicUrl` was guessed from the request rather than configured. */
  publicUrlConfigured: boolean;
  webhookUrl: string;
  app: {
    appId: number;
    slug: string;
    name: string;
    htmlUrl: string;
    ownerLogin: string | null;
    installed: boolean;
    installationId: number | null;
    installedAt: string | null;
    createdAt: string;
    installUrl: string;
  } | null;
};

/**
 * One recorded inbound webhook delivery. Rejected deliveries carry only the
 * headers GitHub sends in the clear — nothing from an unverified payload.
 */
export type WebhookDelivery = {
  id: string;
  /** X-GitHub-Delivery, matches the id in GitHub's own delivery list. */
  deliveryId: string | null;
  event: string;
  verified: boolean;
  outcome: "rejected" | "ignored" | "accepted" | "error";
  detail: string | null;
  repoFullName: string | null;
  branch: string | null;
  commitSha: string | null;
  deployCount: number;
  createdAt: string;
};

export type GitHubRepo = {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
};

export type FsListEntry = { name: string; kind: "file" | "dir" | "symlink" };
export type FsListResponse = { path: string; entries: FsListEntry[] };
export type FsFileResponse = {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  truncated: boolean;
  size: number;
};

export function joinFsPath(dir: string, name: string): string {
  if (dir === "/") return `/${name}`;
  return `${dir}/${name}`;
}

/** GET /api/host-fs — whether the host file browser is on, and its roots. */
export type HostFsStatus = { enabled: boolean; roots: string[] };

export function parentFsPath(p: string): string {
  if (p === "/") return "/";
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

// --- Phase 6: Multi-user ----------------------------------------------------

export type Member = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: string;
  /** True for the row belonging to the signed-in user. */
  isSelf: boolean;
};

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export type Invitation = {
  id: string;
  email: string;
  role: string;
  status: InvitationStatus;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  invitedBy: { id: string; email: string; name: string | null } | null;
};

/**
 * Response to creating an invitation. `token`/`acceptUrl` are returned exactly
 * once — the server stores only a hash — so the UI must not discard them before
 * the admin has copied the link.
 */
export type InvitationCreated = {
  invitation: Invitation;
  token: string;
  acceptUrl: string;
};

/** Pre-auth view of an invitation, for the join page. */
export type InvitationLookup = {
  email: string;
  role: string;
  organizationName: string;
  expiresAt: string;
};

export type AuditLogEntry = {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  actor: {
    id: string | null;
    email: string;
    name: string | null;
    /** The actor's account has since been removed; only the email survives. */
    deleted: boolean;
  };
};

export type AuditLogPage = {
  items: AuditLogEntry[];
  nextCursor: string | null;
};

// --- Phase 7: Managed datastores --------------------------------------------

export type Datastore = {
  id: string;
  kind: "postgres" | "redis";
  name: string;
  slug: string;
  engineVersion: string;
  status: string;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  /** Host port the service is published on; null means private-only. */
  publicPort: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DatastoreBinding = {
  id: string;
  applicationId: string;
  appName: string;
  appSlug: string;
  envKeys: string[];
  createdAt: string;
};

export type DatastoreDetail = Datastore & {
  containerState: string;
  bindings: DatastoreBinding[];
};

// --- Phase 8: Custom domain DNS assist ---------------------------------------

export type DnsProviderInfo = {
  id: string;
  name: string;
  /** Deep link to the provider's DNS console; may embed the zone name. */
  url: string | null;
  /** True when Sohwe can apply the record through this provider's API. */
  apiSupported: boolean;
};

export type DnsInspection = {
  domain: string;
  zone: string | null;
  nameservers: string[];
  provider: DnsProviderInfo | null;
  expectedIp: string | null;
  resolvedIps: string[];
  status: "verified" | "mismatch" | "unresolved" | "unknown";
  record: { type: "A"; name: string; value: string } | null;
};

/** One configured provider credential; the token itself is never returned. */
export type DnsCredentialInfo = {
  provider: string;
  createdAt: string;
  updatedAt: string;
};

export type DnsApplyResult = {
  action: "created" | "updated";
  zone: string;
  record: { type: "A"; name: string; value: string };
  proxied: boolean;
};

/** Response of the deliberate, audited connection-info reveal. */
export type DatastoreConnection = {
  host: string;
  port: number;
  username: string | null;
  database: string | null;
  password: string;
  url: string;
  publicUrl: string | null;
};
