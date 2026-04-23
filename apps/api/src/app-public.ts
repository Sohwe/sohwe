import type { Prisma } from "@sohwe/db";

/** Deployment fields for dashboard lists (excludes `buildLogs`). */
export const deploymentListSelect = {
  id: true,
  status: true,
  imageTag: true,
  commitSha: true,
  commitMessage: true,
  errorMessage: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true
} satisfies Prisma.DeploymentSelect;

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
  buildMode: true,
  buildCmd: true,
  startCmd: true,
  port: true,
  domain: true,
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

type AppListRow = {
  volumes: VolumeRow[];
} & Record<string, unknown>;

export function serializeAppListRow(a: AppListRow) {
  return {
    ...a,
    volumes: a.volumes.map(serializeVolume)
  };
}
