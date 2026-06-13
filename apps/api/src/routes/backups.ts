import type { FastifyInstance } from "fastify";
import parser from "cron-parser";
import { prisma } from "@sohwe/db";
import { buildBundle, parseBundle } from "@sohwe/bundler";
import { encryptJson } from "@sohwe/crypto";
import {
  describeDestination,
  encryptS3Credentials,
  encryptSchedulePassphrase,
  gatherBundleApps,
  makeBundleFilename,
  resolveDestination,
  writeBundle
} from "@sohwe/backups";
import {
  BackupExportSchema,
  CreateBackupDestinationSchema,
  CreateBackupScheduleSchema,
  RestoreApplySchema,
  RestorePreflightSchema,
  UpdateBackupScheduleSchema
} from "@sohwe/types";
import { z } from "zod";
import { authPreHandler } from "../session";

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
    { preHandler: [authPreHandler] },
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
      preHandler: [authPreHandler],
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
      return reply.status(201).send(serializeDestination(row));
    }
  );

  app.delete(
    "/api/backups/destinations/:destId",
    { preHandler: [authPreHandler], schema: { params: DestIdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { destId } = req.params as z.infer<typeof DestIdParam>;
      const existing = await prisma.backupDestination.findFirst({
        where: { id: destId, organizationId: u.organizationId },
        select: { id: true }
      });
      if (!existing) return reply.notFound();
      await prisma.backupDestination.delete({ where: { id: destId } });
      return { ok: true };
    }
  );

  // --- Bundle history ------------------------------------------------------

  app.get("/api/backups", { preHandler: [authPreHandler] }, async (req) => {
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
    { preHandler: [authPreHandler], schema: { body: BackupExportSchema }, ...secretOpts },
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

      const createdAtIso = new Date().toISOString();
      const manifest = buildBundle(bundleApps, {
        passphrase: body.passphrase,
        includeSecrets: body.includeSecrets,
        source: { orgName: u.organization.name, sohweVersion: SOHWE_VERSION },
        createdAtIso
      });

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
        return reply.status(201).send(serializeBundle(row));
      }

      // Download path: record the bundle, then return the file.
      await prisma.bundle.create({
        data: {
          organizationId: u.organizationId,
          filename,
          sizeBytes: BigInt(sizeBytes),
          appCount: bundleApps.length,
          includesSecrets: body.includeSecrets,
          status: "ready"
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
    { preHandler: [authPreHandler], schema: { body: RestorePreflightSchema }, ...secretOpts },
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
        }))
      };
    }
  );

  app.post(
    "/api/backups/restore/apply",
    { preHandler: [authPreHandler], schema: { body: RestoreApplySchema }, ...secretOpts },
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
          const scalars = {
            name: a.name,
            gitRepo: a.gitRepo,
            gitBranch: a.gitBranch,
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
        }

        return { created, overwritten, skipped, renamed };
      });

      return result;
    }
  );

  // --- Schedules (scheduled exports + retention) ---------------------------

  app.get(
    "/api/backups/schedules",
    { preHandler: [authPreHandler] },
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
      preHandler: [authPreHandler],
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
      return reply.status(201).send(serializeSchedule(row));
    }
  );

  app.patch(
    "/api/backups/schedules/:scheduleId",
    {
      preHandler: [authPreHandler],
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
      return serializeSchedule(row);
    }
  );

  app.delete(
    "/api/backups/schedules/:scheduleId",
    { preHandler: [authPreHandler], schema: { params: ScheduleIdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { scheduleId } = req.params as z.infer<typeof ScheduleIdParam>;
      const existing = await prisma.backupSchedule.findFirst({
        where: { id: scheduleId, organizationId: u.organizationId },
        select: { id: true }
      });
      if (!existing) return reply.notFound();
      await prisma.backupSchedule.delete({ where: { id: scheduleId } });
      return { ok: true };
    }
  );
}
