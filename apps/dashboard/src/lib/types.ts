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

export type RestorePreflight = {
  sourceOrgName: string;
  createdAt: string;
  includesSecrets: boolean;
  apps: RestorePreflightApp[];
};

export type RestoreResult = {
  created: number;
  overwritten: number;
  skipped: number;
  renamed: number;
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

export function parentFsPath(p: string): string {
  if (p === "/") return "/";
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}
