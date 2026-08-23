import type { Prisma } from "@sohwe/db";

/** Deployment fields for dashboard lists (excludes `buildLogs`). */
export const deploymentListSelect = {
  id: true,
  status: true,
  imageTag: true,
  commitSha: true,
  commitMessage: true,
  trigger: true,
  errorMessage: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true
} satisfies Prisma.DeploymentSelect;

export const domainListSelect = {
  id: true,
  applicationId: true,
  hostname: true,
  isPrimary: true,
  redirectTo: true,
  lastStatus: true,
  lastCheckedAt: true,
  verifiedAt: true,
  createdAt: true
} satisfies Prisma.DomainSelect;

export const volumeListSelect = {
  id: true,
  mountPath: true,
  sizeBytes: true,
  createdAt: true
} satisfies Prisma.VolumeSelect;

const applicationScalarSelect = {
  id: true,
  organizationId: true,
  name: true,
  slug: true,
  gitRepo: true,
  gitBranch: true,
  repoFullName: true,
  autoDeploy: true,
  buildMode: true,
  buildCmd: true,
  startCmd: true,
  port: true,
  memoryLimitMb: true,
  cpuLimit: true,
  status: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.ApplicationSelect;

/**
 * `Application` + related rows for the dashboard; **never** includes
 * `envVarsEncrypted` (or other secrets).
 */
export function defaultApplicationSelect(
  deploymentTake: number
): Prisma.ApplicationSelect {
  return {
    ...applicationScalarSelect,
    deployments: {
      orderBy: { createdAt: "desc" },
      take: deploymentTake,
      select: deploymentListSelect
    },
    volumes: {
      orderBy: { createdAt: "asc" },
      select: volumeListSelect
    },
    domains: {
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: domainListSelect
    }
  };
}

type VolumeRow = {
  id: string;
  mountPath: string;
  sizeBytes: bigint | null;
  createdAt: Date;
};

/** BigInt is not JSON-serializable; expose size hints as strings. */
export function serializeVolume<T extends VolumeRow>(v: T) {
  return {
    id: v.id,
    mountPath: v.mountPath,
    sizeBytes: v.sizeBytes == null ? null : v.sizeBytes.toString(),
    createdAt: v.createdAt
  };
}

type DomainRow = {
  id: string;
  applicationId: string;
  hostname: string;
  isPrimary: boolean;
  redirectTo: string | null;
  lastStatus: string | null;
  lastCheckedAt: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
};

type AppListRow = {
  volumes: VolumeRow[];
  domains: DomainRow[];
} & Record<string, unknown>;

export function serializeAppListRow(a: AppListRow) {
  return {
    ...a,
    volumes: a.volumes.map(serializeVolume),
    // A projection of `domains`, not a second place domains are stored: the
    // dashboard shows one headline URL per app, and every existing caller of
    // the old `Application.domain` column reads it here unchanged.
    domain: a.domains.find((d) => d.isPrimary)?.hostname ?? null
  };
}
