import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import {
  buildBundle,
  parseBundle,
  type BundleAppInput
} from "@sohwe/bundler";
import { decryptJson, encryptJson } from "@sohwe/crypto";
import {
  BackupExportSchema,
  CreateBackupDestinationSchema,
  RestoreApplySchema,
  RestorePreflightSchema
} from "@sohwe/types";
import { z } from "zod";
import { authPreHandler } from "../session";

const SOHWE_VERSION = process.env.SOHWE_VERSION ?? "0.5.0";

const DestIdParam = z.object({ destId: z.string().uuid() });

function slugifyOrgName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "org";
}

function readEnv(enc: Buffer | null | undefined): Record<string, string> {
  if (!enc || enc.length === 0) return {};
  return decryptJson(Buffer.isBuffer(enc) ? enc : Buffer.from(enc));
}

type DestinationRow = {
  id: string;
  name: string;
  kind: string;
  config: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/** Never exposes `secretEncrypted`; local `config.path` is non-sensitive. */
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
    filename: b.filename,
    sizeBytes: b.sizeBytes == null ? null : b.sizeBytes.toString(),
    appCount: b.appCount,
    includesSecrets: b.includesSecrets,
    status: b.status,
    errorMessage: b.errorMessage,
    createdAt: b.createdAt
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
      schema: { body: CreateBackupDestinationSchema }
    },
    async (req, reply) => {
      const u = req.user!;
      const body = CreateBackupDestinationSchema.parse(req.body);
      const row = await prisma.backupDestination.create({
        data: {
          organizationId: u.organizationId,
          name: body.name,
          kind: body.kind,
          config: body.config
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

      const apps = await prisma.application.findMany({
        where: { organizationId: u.organizationId },
        include: {
          volumes: { orderBy: { createdAt: "asc" } },
          alertDestinations: { orderBy: { createdAt: "asc" } }
        },
        orderBy: { createdAt: "asc" }
      });

      let bundleApps: BundleAppInput[];
      try {
        bundleApps = apps.map((a) => ({
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
          envVars: body.includeSecrets ? readEnv(a.envVarsEncrypted) : {}
        }));
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
      const stamp = createdAtIso.replace(/[:.]/g, "-");
      const filename = `sohwe-backup-${slugifyOrgName(u.organization.name)}-${stamp}.sohwe.json`;

      // Write to a configured local destination, or stream as a download.
      if (body.destinationId) {
        const dest = await prisma.backupDestination.findFirst({
          where: { id: body.destinationId, organizationId: u.organizationId }
        });
        if (!dest) return reply.notFound();
        if (dest.kind !== "local") {
          return reply.badRequest("Only local destinations are supported");
        }
        const cfg = dest.config as { path?: unknown } | null;
        const dir = typeof cfg?.path === "string" ? cfg.path : null;
        if (!dir) {
          return reply.badRequest("Destination is missing a path");
        }
        try {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, filename), json, "utf8");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await prisma.bundle.create({
            data: {
              organizationId: u.organizationId,
              destinationId: dest.id,
              filename,
              sizeBytes: BigInt(sizeBytes),
              appCount: bundleApps.length,
              includesSecrets: body.includeSecrets,
              status: "failed",
              errorMessage: msg
            }
          });
          return reply
            .status(500)
            .send({ message: `Failed to write bundle to destination: ${msg}` });
        }
        const row = await prisma.bundle.create({
          data: {
            organizationId: u.organizationId,
            destinationId: dest.id,
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
}
