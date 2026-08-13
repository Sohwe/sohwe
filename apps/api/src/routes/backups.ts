import type { FastifyInstance } from "fastify";
import parser from "cron-parser";
import { Prisma, prisma } from "@sohwe/db";
import {
  buildBundle,
  parseBundle,
  type BundleDatastoreEntry
} from "@sohwe/bundler";
import { decryptJson, encryptJson } from "@sohwe/crypto";
import { parseGitHubRepoUrl, repoFullName } from "@sohwe/github";
import {
  describeDestination,
  encryptS3Credentials,
  encryptSchedulePassphrase,
  gatherBundleApps,
  gatherBundleDatastores,
  makeBundleFilename,
  resolveDestination,
  writeBundle
} from "@sohwe/backups";
import {
  BackupExportSchema,
  buildDatastoreConnectionUrl,
  DATASTORE_KINDS,
  DATASTORE_PUBLIC_PORT_MAX,
  DATASTORE_PUBLIC_PORT_MIN,
  datastoreContainerName,
  datastoreEngineVersions,
  datastoreServicePort,
  type DatastoreCredentials,
  type DatastoreKind,
  CreateBackupDestinationSchema,
  CreateBackupScheduleSchema,
  RestoreApplySchema,
  RestorePreflightSchema,
  UpdateBackupScheduleSchema
} from "@sohwe/types";
import { z } from "zod";
import { recordAudit } from "../audit";
import { generateDatastoreCredentials } from "./datastores";
import { requireRole } from "../rbac";

// Admin-and-above throughout. Bundles carry re-encrypted env vars and restore
// can overwrite live app configuration, so neither side of it is a member action.

function readEncJson(enc: Buffer | Uint8Array | null): Record<string, string> {
  if (!enc || enc.length === 0) return {};
  return decryptJson(Buffer.isBuffer(enc) ? enc : Buffer.from(enc));
}

type RestoredDatastoreCounts = {
  datastoresCreated: number;
  datastoresOverwritten: number;
  datastoresSkipped: number;
  datastoresRenamed: number;
  bindingsRestored: number;
  bindingsDropped: number;
};

/**
 * Restore the bundle's datastore entries inside the same transaction as the
 * apps. Bundles carry config only, so every created datastore gets fresh
 * credentials and lands in `idle` — nothing provisions until the user acts,
 * mirroring restored apps. Bindings are re-pointed at the restored apps (by
 * bundle slug) and the injected env keys are rewritten with this instance's
 * new credentials, so provision -> deploy works without a manual re-bind.
 *
 * `overwrite` narrows deliberately for datastores: only name and resource
 * limits are updated. Engine version, credentials, status, and public port of
 * a live datastore are never touched — swapping an engine under an existing
 * data volume is destructive.
 */
async function restoreDatastores(
  tx: Prisma.TransactionClient,
  organizationId: string,
  entries: BundleDatastoreEntry[],
  collisionPolicy: "rename" | "overwrite" | "skip",
  appIdByBundleSlug: Map<string, string>
): Promise<RestoredDatastoreCounts> {
  const counts: RestoredDatastoreCounts = {
    datastoresCreated: 0,
    datastoresOverwritten: 0,
    datastoresSkipped: 0,
    datastoresRenamed: 0,
    bindingsRestored: 0,
    bindingsDropped: 0
  };
  if (entries.length === 0) return counts;

  const existing = await tx.datastore.findMany({
    where: { organizationId },
    select: { id: true, slug: true }
  });
  const usedSlugs = new Set(existing.map((d) => d.slug));
  const idBySlug = new Map(existing.map((d) => [d.slug, d.id]));
  // publicPort is unique across the whole instance, not just this org.
  const portRows = await tx.datastore.findMany({
    where: { publicPort: { not: null } },
    select: { publicPort: true }
  });
  const usedPorts = new Set(portRows.map((r) => r.publicPort));

  /** Bundle datastore slug -> what it became on this instance. */
  const mapped = new Map<
    string,
    { id: string; kind: DatastoreKind; slug: string; creds: DatastoreCredentials }
  >();

  for (const d of entries) {
    if (!(DATASTORE_KINDS as readonly string[]).includes(d.kind)) {
      counts.datastoresSkipped++;
      counts.bindingsDropped += d.bindings.length;
      continue;
    }
    const kind = d.kind as DatastoreKind;
    const collides = usedSlugs.has(d.slug);

    if (collides && collisionPolicy === "skip") {
      counts.datastoresSkipped++;
      counts.bindingsDropped += d.bindings.length;
      continue;
    }

    if (collides && collisionPolicy === "overwrite") {
      const id = idBySlug.get(d.slug)!;
      const row = await tx.datastore.update({
        where: { id },
        data: {
          name: d.name,
          memoryLimitMb: d.memoryLimitMb,
          cpuLimit: d.cpuLimit
        }
      });
      const vars = readEncJson(row.credentialsEncrypted);
      mapped.set(d.slug, {
        id,
        kind,
        slug: row.slug,
        creds: {
          username: vars.username,
          password: vars.password ?? "",
          database: vars.database
        }
      });
      counts.datastoresOverwritten++;
      continue;
    }

    let slug = d.slug;
    if (collides) {
      slug = `${d.slug}-restored`;
      let n = 2;
      while (usedSlugs.has(slug)) slug = `${d.slug}-restored-${n++}`;
      counts.datastoresRenamed++;
    } else {
      counts.datastoresCreated++;
    }

    // A bundle from a newer Sohwe may name a version this build cannot run.
    const versions = datastoreEngineVersions(kind);
    const engineVersion = versions.includes(d.engineVersion)
      ? d.engineVersion
      : versions[0]!;

    // Ports are host-specific: keep the bundled one only if it is valid and
    // free here; otherwise the datastore lands private and the user re-enables.
    let publicPort: number | null = null;
    if (
      d.publicPort != null &&
      d.publicPort >= DATASTORE_PUBLIC_PORT_MIN &&
      d.publicPort <= DATASTORE_PUBLIC_PORT_MAX &&
      !usedPorts.has(d.publicPort)
    ) {
      publicPort = d.publicPort;
      usedPorts.add(d.publicPort);
    }

    const creds = generateDatastoreCredentials(kind, slug);
    const row = await tx.datastore.create({
      data: {
        organizationId,
        kind,
        name: d.name,
        slug,
        engineVersion,
        status: "idle",
        memoryLimitMb: d.memoryLimitMb,
        cpuLimit: d.cpuLimit,
        publicPort,
        credentialsEncrypted: encryptJson(creds)
      }
    });
    usedSlugs.add(slug);
    idBySlug.set(slug, row.id);
    mapped.set(d.slug, {
      id: row.id,
      kind,
      slug,
      creds: {
        username: creds.username,
        password: creds.password ?? "",
        database: creds.database
      }
    });
  }

  for (const d of entries) {
    const ds = mapped.get(d.slug);
    if (!ds) continue; // skipped above; its bindings are already counted
    const url = buildDatastoreConnectionUrl(
      ds.kind,
      ds.creds,
      datastoreContainerName(ds.slug),
      datastoreServicePort(ds.kind)
    );
    for (const b of d.bindings) {
      const appId = appIdByBundleSlug.get(b.appSlug);
      if (!appId || b.envKeys.length === 0) {
        counts.bindingsDropped++;
        continue;
      }
      const existingBinding = await tx.datastoreBinding.findFirst({
        where: { datastoreId: ds.id, applicationId: appId },
        select: { id: true }
      });
      if (existingBinding) {
        await tx.datastoreBinding.update({
          where: { id: existingBinding.id },
          data: { envKeys: b.envKeys }
        });
      } else {
        await tx.datastoreBinding.create({
          data: { datastoreId: ds.id, applicationId: appId, envKeys: b.envKeys }
        });
      }
      const app = await tx.application.findUnique({
        where: { id: appId },
        select: { envVarsEncrypted: true }
      });
      const envMap = readEncJson(app?.envVarsEncrypted ?? null);
      for (const key of b.envKeys) envMap[key] = url;
      await tx.application.update({
        where: { id: appId },
        data: { envVarsEncrypted: encryptJson(envMap) }
      });
      counts.bindingsRestored++;
    }
  }

  return counts;
}

const SOHWE_VERSION = process.env.SOHWE_VERSION ?? "0.5.0";

const DestIdParam = z.object({ destId: z.string().uuid() });
const ScheduleIdParam = z.object({ scheduleId: z.string().uuid() });

/** Validate a cron string; returns an error message or null. */
function cronError(cron: string): string | null {
  try {
    parser.parseExpression(cron);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid cron expression";
  }
}

type DestinationRow = {
  id: string;
  name: string;
  kind: string;
  config: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Never exposes `secretEncrypted` (S3 credentials). The `config` is
 * non-sensitive for both kinds (local path; S3 bucket/region/endpoint/prefix).
 */
function serializeDestination(d: DestinationRow) {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    config: d.config,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt
  };
}

type BundleRow = {
  id: string;
  destinationId: string | null;
  scheduleId: string | null;
  filename: string;
  sizeBytes: bigint | null;
  appCount: number;
  includesSecrets: boolean;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
};

function serializeBundle(b: BundleRow) {
  return {
    id: b.id,
    destinationId: b.destinationId,
    scheduleId: b.scheduleId,
    filename: b.filename,
    sizeBytes: b.sizeBytes == null ? null : b.sizeBytes.toString(),
    appCount: b.appCount,
    includesSecrets: b.includesSecrets,
    status: b.status,
    errorMessage: b.errorMessage,
    createdAt: b.createdAt
  };
}

type ScheduleRow = {
  id: string;
  destinationId: string;
  cron: string;
  enabled: boolean;
  includeSecrets: boolean;
  retentionCount: number | null;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  destination?: { name: string; kind: string } | null;
};

/** Never exposes `passphraseEncrypted`. */
function serializeSchedule(s: ScheduleRow) {
  return {
    id: s.id,
    destinationId: s.destinationId,
    destinationName: s.destination?.name ?? null,
    destinationKind: s.destination?.kind ?? null,
    cron: s.cron,
    enabled: s.enabled,
    includeSecrets: s.includeSecrets,
    retentionCount: s.retentionCount,
    lastRunAt: s.lastRunAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  };
}

/** Portable config bundles: destinations, export, and restore (Phase 4.5). */
export async function registerBackupRoutes(app: FastifyInstance) {
  const secretOpts = { logLevel: "silent" as const };

  // --- Destinations --------------------------------------------------------

  app.get(
    "/api/backups/destinations",
    { preHandler: [requireRole("admin")] },
    async (req) => {
      const u = req.user!;
      const rows = await prisma.backupDestination.findMany({
        where: { organizationId: u.organizationId },
        orderBy: { createdAt: "asc" }
      });
      return { destinations: rows.map(serializeDestination) };
    }
  );

  app.post(
    "/api/backups/destinations",
    {
      preHandler: [requireRole("admin")],
      schema: { body: CreateBackupDestinationSchema },
      ...secretOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const body = CreateBackupDestinationSchema.parse(req.body);
      // S3 credentials are encrypted at rest and never stored in `config`.
      const secretEncrypted =
        body.kind === "s3" ? encryptS3Credentials(body.credentials) : null;
      const row = await prisma.backupDestination.create({
        data: {
          organizationId: u.organizationId,
          name: body.name,
          kind: body.kind,
          config: body.config,
          secretEncrypted
        }
      });
      await recordAudit(req, {
        action: "backup.destination.create",
        targetType: "backup",
        targetId: row.id,
        targetLabel: row.name,
        // Kind only; the S3 credentials never leave `secretEncrypted`.
        metadata: { kind: row.kind }
      });
      return reply.status(201).send(serializeDestination(row));
    }
  );

  app.delete(
    "/api/backups/destinations/:destId",
    { preHandler: [requireRole("admin")], schema: { params: DestIdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { destId } = req.params as z.infer<typeof DestIdParam>;
      const existing = await prisma.backupDestination.findFirst({
        where: { id: destId, organizationId: u.organizationId },
        select: { id: true, name: true, kind: true }
      });
      if (!existing) return reply.notFound();
      await prisma.backupDestination.delete({ where: { id: destId } });
      await recordAudit(req, {
        action: "backup.destination.delete",
        targetType: "backup",
        targetId: existing.id,
        targetLabel: existing.name,
        metadata: { kind: existing.kind }
      });
      return { ok: true };
    }
  );

  // --- Bundle history ------------------------------------------------------

  app.get("/api/backups", { preHandler: [requireRole("admin")] }, async (req) => {
    const u = req.user!;
    const rows = await prisma.bundle.findMany({
      where: { organizationId: u.organizationId },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return { bundles: rows.map(serializeBundle) };
  });

  // --- Export --------------------------------------------------------------

  app.post(
    "/api/backups/export",
    { preHandler: [requireRole("admin")], schema: { body: BackupExportSchema }, ...secretOpts },
    async (req, reply) => {
      const u = req.user!;
      const body = BackupExportSchema.parse(req.body);

      let bundleApps;
      try {
        bundleApps = await gatherBundleApps(
          u.organizationId,
          body.includeSecrets
        );
      } catch {
        return reply
          .status(500)
          .send({ message: "Failed to read env var configuration for export" });
      }

      const bundleDatastores = await gatherBundleDatastores(u.organizationId);

      const createdAtIso = new Date().toISOString();
      const manifest = buildBundle(
        bundleApps,
        {
          passphrase: body.passphrase,
          includeSecrets: body.includeSecrets,
          source: { orgName: u.organization.name, sohweVersion: SOHWE_VERSION },
          createdAtIso
        },
        bundleDatastores
      );

      const json = JSON.stringify(manifest);
      const sizeBytes = Buffer.byteLength(json, "utf8");
      const filename = makeBundleFilename(u.organization.name, createdAtIso);

      // Write to a configured destination (local or S3), or stream as a download.
      if (body.destinationId) {
        const destRow = await prisma.backupDestination.findFirst({
          where: { id: body.destinationId, organizationId: u.organizationId }
        });
        if (!destRow) return reply.notFound();

        let dest;
        try {
          dest = resolveDestination(destRow);
        } catch (e) {
          return reply.badRequest(
            e instanceof Error ? e.message : "Invalid destination"
          );
        }

        try {
          await writeBundle(dest, filename, json);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await prisma.bundle.create({
            data: {
              organizationId: u.organizationId,
              destinationId: destRow.id,
              filename,
              sizeBytes: BigInt(sizeBytes),
              appCount: bundleApps.length,
              includesSecrets: body.includeSecrets,
              status: "failed",
              errorMessage: `Write to ${describeDestination(dest)} failed: ${msg}`
            }
          });
          return reply
            .status(500)
            .send({ message: `Failed to write bundle to destination: ${msg}` });
        }
        const row = await prisma.bundle.create({
          data: {
            organizationId: u.organizationId,
            destinationId: destRow.id,
            filename,
            sizeBytes: BigInt(sizeBytes),
            appCount: bundleApps.length,
            includesSecrets: body.includeSecrets,
            status: "ready"
          }
        });
        await recordAudit(req, {
          action: "backup.export",
          targetType: "backup",
          targetId: row.id,
          targetLabel: filename,
          metadata: {
            mode: "destination",
            destinationId: destRow.id,
            appCount: bundleApps.length,
            includesSecrets: body.includeSecrets
          }
        });
        return reply.status(201).send(serializeBundle(row));
      }

      // Download path: record the bundle, then return the file.
      const downloaded = await prisma.bundle.create({
        data: {
          organizationId: u.organizationId,
          filename,
          sizeBytes: BigInt(sizeBytes),
          appCount: bundleApps.length,
          includesSecrets: body.includeSecrets,
          status: "ready"
        }
      });
      await recordAudit(req, {
        action: "backup.export",
        targetType: "backup",
        targetId: downloaded.id,
        targetLabel: filename,
        metadata: {
          mode: "download",
          appCount: bundleApps.length,
          includesSecrets: body.includeSecrets
        }
      });
      reply
        .header("content-type", "application/json; charset=utf-8")
        .header("content-disposition", `attachment; filename="${filename}"`);
      return reply.send(json);
    }
  );

  // --- Restore -------------------------------------------------------------

  app.post(
    "/api/backups/restore/preflight",
    { preHandler: [requireRole("admin")], schema: { body: RestorePreflightSchema }, ...secretOpts },
    async (req, reply) => {
      const u = req.user!;
      const body = RestorePreflightSchema.parse(req.body);

      let parsed;
      try {
        parsed = parseBundle(body.bundle, body.passphrase);
      } catch (e) {
        return reply.badRequest(e instanceof Error ? e.message : "Invalid bundle");
      }

      const existing = await prisma.application.findMany({
        where: { organizationId: u.organizationId },
        select: { slug: true }
      });
      const existingSlugs = new Set(existing.map((a) => a.slug));
      const existingDs = await prisma.datastore.findMany({
        where: { organizationId: u.organizationId },
        select: { slug: true }
      });
      const existingDsSlugs = new Set(existingDs.map((d) => d.slug));

      return {
        sourceOrgName: parsed.source.orgName,
        createdAt: parsed.createdAt,
        includesSecrets: parsed.includesSecrets,
        apps: parsed.apps.map((a) => ({
          name: a.name,
          slug: a.slug,
          collides: existingSlugs.has(a.slug),
          volumeCount: a.volumes.length,
          alertCount: a.alertDestinations.length,
          envKeyCount: Object.keys(a.envVars).length
        })),
        datastores: parsed.datastores.map((d) => ({
          name: d.name,
          slug: d.slug,
          kind: d.kind,
          engineVersion: d.engineVersion,
          collides: existingDsSlugs.has(d.slug),
          bindingCount: d.bindings.length
        }))
      };
    }
  );

  app.post(
    "/api/backups/restore/apply",
    { preHandler: [requireRole("admin")], schema: { body: RestoreApplySchema }, ...secretOpts },
    async (req, reply) => {
      const u = req.user!;
      const body = RestoreApplySchema.parse(req.body);

      let parsed;
      try {
        parsed = parseBundle(body.bundle, body.passphrase);
      } catch (e) {
        return reply.badRequest(e instanceof Error ? e.message : "Invalid bundle");
      }

      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.application.findMany({
          where: { organizationId: u.organizationId },
          select: { id: true, slug: true }
        });
        const usedSlugs = new Set(existing.map((a) => a.slug));
        const idBySlug = new Map(existing.map((a) => [a.slug, a.id]));

        let created = 0;
        let overwritten = 0;
        let skipped = 0;
        let renamed = 0;
        /** Bundle app slug -> restored/overwritten app id, for datastore bindings. */
        const appIdByBundleSlug = new Map<string, string>();

        for (const a of parsed.apps) {
          const collides = usedSlugs.has(a.slug);
          const envEncrypted =
            Object.keys(a.envVars).length > 0 ? encryptJson(a.envVars) : null;
          const volumeCreate = a.volumes.map((v) => ({
            mountPath: v.mountPath,
            sizeBytes: v.sizeBytes == null ? null : BigInt(v.sizeBytes)
          }));
          const alertCreate = a.alertDestinations.map((d) => ({
            type: d.type,
            name: d.name,
            url: d.url,
            enabled: d.enabled
          }));
          const restoredRef = parseGitHubRepoUrl(a.gitRepo);
          const scalars = {
            name: a.name,
            gitRepo: a.gitRepo,
            gitBranch: a.gitBranch,
            // Derived, not carried in the bundle. `autoDeploy` deliberately
            // stays off: a restored app must not start deploying on push
            // against whatever instance it landed on.
            repoFullName: restoredRef ? repoFullName(restoredRef) : null,
            buildMode: a.buildMode,
            buildCmd: a.buildCmd,
            startCmd: a.startCmd,
            port: a.port,
            domain: a.domain,
            memoryLimitMb: a.memoryLimitMb,
            cpuLimit: a.cpuLimit,
            envVarsEncrypted: envEncrypted
          };

          if (collides && body.collisionPolicy === "skip") {
            skipped++;
            continue;
          }

          if (collides && body.collisionPolicy === "overwrite") {
            const appId = idBySlug.get(a.slug)!;
            appIdByBundleSlug.set(a.slug, appId);
            await tx.application.update({
              where: { id: appId },
              data: { ...scalars, status: "idle" }
            });
            await tx.volume.deleteMany({ where: { applicationId: appId } });
            await tx.alertDestination.deleteMany({ where: { applicationId: appId } });
            if (volumeCreate.length > 0) {
              await tx.volume.createMany({
                data: volumeCreate.map((v) => ({ ...v, applicationId: appId }))
              });
            }
            for (const d of alertCreate) {
              await tx.alertDestination.create({ data: { ...d, applicationId: appId } });
            }
            overwritten++;
            continue;
          }

          // Create (either no collision, or rename policy).
          let slug = a.slug;
          if (collides) {
            slug = `${a.slug}-restored`;
            let n = 2;
            while (usedSlugs.has(slug)) slug = `${a.slug}-restored-${n++}`;
            renamed++;
          } else {
            created++;
          }

          const newApp = await tx.application.create({
            data: {
              organizationId: u.organizationId,
              slug,
              status: "idle",
              ...scalars,
              volumes: volumeCreate.length > 0 ? { create: volumeCreate } : undefined,
              alertDestinations:
                alertCreate.length > 0 ? { create: alertCreate } : undefined
            }
          });
          usedSlugs.add(slug);
          idBySlug.set(slug, newApp.id);
          appIdByBundleSlug.set(a.slug, newApp.id);
        }

        const datastores = await restoreDatastores(
          tx,
          u.organizationId,
          parsed.datastores,
          body.collisionPolicy,
          appIdByBundleSlug
        );

        return { created, overwritten, skipped, renamed, ...datastores };
      });

      await recordAudit(req, {
        action: "backup.restore",
        targetType: "backup",
        targetLabel: parsed.source.orgName,
        metadata: {
          collisionPolicy: body.collisionPolicy,
          includesSecrets: parsed.includesSecrets,
          bundleCreatedAt: parsed.createdAt,
          ...result
        }
      });
      return result;
    }
  );

  // --- Schedules (scheduled exports + retention) ---------------------------

  app.get(
    "/api/backups/schedules",
    { preHandler: [requireRole("admin")] },
    async (req) => {
      const u = req.user!;
      const rows = await prisma.backupSchedule.findMany({
        where: { organizationId: u.organizationId },
        orderBy: { createdAt: "asc" },
        include: { destination: { select: { name: true, kind: true } } }
      });
      return { schedules: rows.map(serializeSchedule) };
    }
  );

  app.post(
    "/api/backups/schedules",
    {
      preHandler: [requireRole("admin")],
      schema: { body: CreateBackupScheduleSchema },
      ...secretOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const body = CreateBackupScheduleSchema.parse(req.body);

      const cronMsg = cronError(body.cron);
      if (cronMsg) return reply.badRequest(`Invalid cron: ${cronMsg}`);

      // The destination must belong to the caller's org.
      const dest = await prisma.backupDestination.findFirst({
        where: { id: body.destinationId, organizationId: u.organizationId },
        select: { id: true }
      });
      if (!dest) return reply.badRequest("Unknown destination");

      const row = await prisma.backupSchedule.create({
        data: {
          organizationId: u.organizationId,
          destinationId: body.destinationId,
          cron: body.cron,
          enabled: body.enabled,
          includeSecrets: body.includeSecrets,
          passphraseEncrypted: encryptSchedulePassphrase(body.passphrase),
          retentionCount: body.retentionCount ?? null
        },
        include: { destination: { select: { name: true, kind: true } } }
      });
      await recordAudit(req, {
        action: "backup.schedule.create",
        targetType: "backup",
        targetId: row.id,
        targetLabel: row.destination.name,
        // Never the passphrase.
        metadata: {
          cron: row.cron,
          enabled: row.enabled,
          includesSecrets: row.includeSecrets,
          retentionCount: row.retentionCount
        }
      });
      return reply.status(201).send(serializeSchedule(row));
    }
  );

  app.patch(
    "/api/backups/schedules/:scheduleId",
    {
      preHandler: [requireRole("admin")],
      schema: { params: ScheduleIdParam, body: UpdateBackupScheduleSchema },
      ...secretOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { scheduleId } = req.params as z.infer<typeof ScheduleIdParam>;
      const body = UpdateBackupScheduleSchema.parse(req.body);

      const existing = await prisma.backupSchedule.findFirst({
        where: { id: scheduleId, organizationId: u.organizationId },
        select: { id: true }
      });
      if (!existing) return reply.notFound();

      if (body.cron !== undefined) {
        const cronMsg = cronError(body.cron);
        if (cronMsg) return reply.badRequest(`Invalid cron: ${cronMsg}`);
      }

      const row = await prisma.backupSchedule.update({
        where: { id: scheduleId },
        data: {
          cron: body.cron,
          enabled: body.enabled,
          includeSecrets: body.includeSecrets,
          retentionCount:
            body.retentionCount === undefined ? undefined : body.retentionCount,
          passphraseEncrypted:
            body.passphrase === undefined
              ? undefined
              : encryptSchedulePassphrase(body.passphrase)
        },
        include: { destination: { select: { name: true, kind: true } } }
      });
      await recordAudit(req, {
        action: "backup.schedule.update",
        targetType: "backup",
        targetId: row.id,
        targetLabel: row.destination.name,
        // Records *that* the passphrase changed, never the value.
        metadata: {
          fields: Object.keys(body).sort(),
          cron: row.cron,
          enabled: row.enabled
        }
      });
      return serializeSchedule(row);
    }
  );

  app.delete(
    "/api/backups/schedules/:scheduleId",
    { preHandler: [requireRole("admin")], schema: { params: ScheduleIdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { scheduleId } = req.params as z.infer<typeof ScheduleIdParam>;
      const existing = await prisma.backupSchedule.findFirst({
        where: { id: scheduleId, organizationId: u.organizationId },
        select: { id: true, cron: true, destination: { select: { name: true } } }
      });
      if (!existing) return reply.notFound();
      await prisma.backupSchedule.delete({ where: { id: scheduleId } });
      await recordAudit(req, {
        action: "backup.schedule.delete",
        targetType: "backup",
        targetId: existing.id,
        targetLabel: existing.destination.name,
        metadata: { cron: existing.cron }
      });
      return { ok: true };
    }
  );
}
