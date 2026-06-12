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
