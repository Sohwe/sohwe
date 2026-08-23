import {
  buildBundle,
  type BundleAppInput,
  type BundleDatastoreInput
} from "@sohwe/bundler";
import { decryptJson, encryptJson } from "@sohwe/crypto";
import { prisma } from "@sohwe/db";
import {
  deleteBundle,
  describeDestination,
  resolveDestination,
  writeBundle,
  type ResolvedDestination
} from "./storage";

function slugifyOrgName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "org"
  );
}

function readVars(enc: Buffer | Uint8Array | null | undefined): Record<string, string> {
  if (!enc || enc.length === 0) return {};
  return decryptJson(Buffer.isBuffer(enc) ? enc : Buffer.from(enc));
}

/** Bundle filename for an org export stamped at `createdAtIso`. */
export function makeBundleFilename(orgName: string, createdAtIso: string): string {
  const stamp = createdAtIso.replace(/[:.]/g, "-");
  return `sohwe-backup-${slugifyOrgName(orgName)}-${stamp}.sohwe.json`;
}

/**
 * Read every app in an org and shape it for the bundler. Env vars and build
 * variables are only decrypted/included when `includeSecrets` is set. Shared by
 * the API's manual export and the worker's scheduled export so both produce
 * identical bundles.
 */
export async function gatherBundleApps(
  organizationId: string,
  includeSecrets: boolean
): Promise<BundleAppInput[]> {
  const apps = await prisma.application.findMany({
    where: { organizationId },
    include: {
      volumes: { orderBy: { createdAt: "asc" } },
      alertDestinations: { orderBy: { createdAt: "asc" } }
    },
    orderBy: { createdAt: "asc" }
  });

  return apps.map((a) => ({
    name: a.name,
    slug: a.slug,
    gitRepo: a.gitRepo,
    gitBranch: a.gitBranch,
    buildMode: a.buildMode,
    buildCmd: a.buildCmd,
    startCmd: a.startCmd,
    port: a.port,
    domain: a.domain,
    memoryLimitMb: a.memoryLimitMb,
    cpuLimit: a.cpuLimit == null ? null : Number(a.cpuLimit),
    volumes: a.volumes.map((v) => ({
      mountPath: v.mountPath,
      sizeBytes: v.sizeBytes == null ? null : v.sizeBytes.toString()
    })),
    alertDestinations: a.alertDestinations.map((d) => ({
      type: d.type,
      name: d.name,
      url: d.url,
      enabled: d.enabled
    })),
    envVars: includeSecrets ? readVars(a.envVarsEncrypted) : {},
    buildArgs: includeSecrets ? readVars(a.buildArgsEncrypted) : {}
  }));
}

/**
 * Read every managed datastore in an org and shape it for the bundler —
 * config only, never credentials. Bindings reference apps by slug because ids
 * differ across instances. Shared by manual and scheduled export.
 */
export async function gatherBundleDatastores(
  organizationId: string
): Promise<BundleDatastoreInput[]> {
  const rows = await prisma.datastore.findMany({
    where: { organizationId },
    include: {
      bindings: {
        include: { application: { select: { slug: true } } },
        orderBy: { createdAt: "asc" }
      }
    },
    orderBy: { createdAt: "asc" }
  });
  return rows.map((d) => ({
    kind: d.kind,
    name: d.name,
    slug: d.slug,
    engineVersion: d.engineVersion,
    memoryLimitMb: d.memoryLimitMb,
    cpuLimit: d.cpuLimit == null ? null : Number(d.cpuLimit),
    publicPort: d.publicPort,
    bindings: d.bindings.map((b) => ({
      appSlug: b.application.slug,
      envKeys: b.envKeys
    }))
  }));
}

/**
 * Prune a schedule's stored bundles down to its newest `retentionCount`,
 * removing both the destination file and the history row. Failures to delete a
 * remote file are tolerated (the row is still removed) so retention converges.
 */
export async function applyRetention(
  scheduleId: string,
  dest: ResolvedDestination,
  retentionCount: number | null | undefined
): Promise<number> {
  if (!retentionCount || retentionCount < 1) return 0;
  const ready = await prisma.bundle.findMany({
    where: { scheduleId, status: "ready" },
    orderBy: { createdAt: "desc" },
    select: { id: true, filename: true }
  });
  const excess = ready.slice(retentionCount);
  let removed = 0;
  for (const b of excess) {
    try {
      await deleteBundle(dest, b.filename);
    } catch {
      // Tolerate a missing/unreachable remote object; still drop the row.
    }
    await prisma.bundle.delete({ where: { id: b.id } });
    removed++;
  }
  return removed;
}

export type ScheduledExportResult = {
  bundleId: string;
  filename: string;
  status: "ready" | "failed";
  appCount: number;
  retentionRemoved: number;
};

/**
 * Run one scheduled export end to end: build the bundle, write it to the
 * schedule's destination, record a `Bundle` row, then apply retention. Records
 * a `failed` row (and rethrows) if the write fails, so history reflects it.
 */
export async function runScheduledExport(
  scheduleId: string,
  sohweVersion: string
): Promise<ScheduledExportResult> {
  const schedule = await prisma.backupSchedule.findUnique({
    where: { id: scheduleId },
    include: { destination: true, organization: true }
  });
  if (!schedule) throw new Error(`Schedule ${scheduleId} not found`);

  const passphrase = readPassphrase(schedule.passphraseEncrypted);
  const dest = resolveDestination(schedule.destination);

  const createdAtIso = new Date().toISOString();
  const filename = makeBundleFilename(schedule.organization.name, createdAtIso);

  const bundleApps = await gatherBundleApps(
    schedule.organizationId,
    schedule.includeSecrets
  );
  const bundleDatastores = await gatherBundleDatastores(schedule.organizationId);
  const manifest = buildBundle(
    bundleApps,
    {
      passphrase,
      includeSecrets: schedule.includeSecrets,
      source: {
        orgName: schedule.organization.name,
        sohweVersion
      },
      createdAtIso
    },
    bundleDatastores
  );
  const json = JSON.stringify(manifest);
  const sizeBytes = Buffer.byteLength(json, "utf8");

  try {
    await writeBundle(dest, filename, json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const failed = await prisma.bundle.create({
      data: {
        organizationId: schedule.organizationId,
        destinationId: schedule.destinationId,
        scheduleId: schedule.id,
        filename,
        sizeBytes: BigInt(sizeBytes),
        appCount: bundleApps.length,
        includesSecrets: schedule.includeSecrets,
        status: "failed",
        errorMessage: `Write to ${describeDestination(dest)} failed: ${msg}`
      }
    });
    throw Object.assign(
      new Error(`Scheduled export failed: ${msg}`),
      { bundleId: failed.id }
    );
  }

  const row = await prisma.bundle.create({
    data: {
      organizationId: schedule.organizationId,
      destinationId: schedule.destinationId,
      scheduleId: schedule.id,
      filename,
      sizeBytes: BigInt(sizeBytes),
      appCount: bundleApps.length,
      includesSecrets: schedule.includeSecrets,
      status: "ready"
    }
  });

  const retentionRemoved = await applyRetention(
    schedule.id,
    dest,
    schedule.retentionCount
  );

  return {
    bundleId: row.id,
    filename,
    status: "ready",
    appCount: bundleApps.length,
    retentionRemoved
  };
}

function readPassphrase(enc: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(enc) ? enc : Buffer.from(enc);
  const obj = decryptJson(buf);
  const pass = obj.passphrase;
  if (!pass) throw new Error("Schedule passphrase could not be read");
  return pass;
}

/** Encrypt a schedule passphrase at rest with the instance key. */
export function encryptSchedulePassphrase(passphrase: string): Buffer {
  return encryptJson({ passphrase });
}

/** Encrypt S3 credentials at rest with the instance key. */
export function encryptS3Credentials(creds: {
  accessKeyId: string;
  secretAccessKey: string;
}): Buffer {
  return encryptJson(creds);
}
