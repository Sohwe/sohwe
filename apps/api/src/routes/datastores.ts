import { randomBytes, randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import { decryptJson, encryptJson } from "@sohwe/crypto";
import {
  appInternalNetworkName,
  buildDatastoreConnectionUrl,
  CreateDatastoreBindingSchema,
  CreateDatastoreSchema,
  DATASTORE_LABEL,
  DATASTORE_PUBLIC_PORT_MAX,
  DATASTORE_PUBLIC_PORT_MIN,
  DatastorePublicAccessSchema,
  datastoreContainerName,
  datastoreDefaultEnvKey,
  datastoreEngineVersions,
  datastoreServicePort,
  type DatastoreCredentials,
  type DatastoreKind
} from "@sohwe/types";
import { createDatastoreQueue, DATASTORE_DELETE_JOB, DATASTORE_PROVISION_JOB, DATASTORE_ROTATE_JOB } from "@sohwe/queue";
import Docker from "dockerode";
import { z } from "zod";
import { envChangeMetadata, recordAudit } from "../audit";
import type { ApiConfig } from "../env";
import { requireRole } from "../rbac";

const docker = new Docker();

const IdParam = z.object({ id: z.string().uuid() });
const BindingParam = z.object({
  id: z.string().uuid(),
  bindingId: z.string().uuid()
});

// Datastores are secret-adjacent end to end — even the list names what backs
// an app — and every mutation touches credentials or app env vars, so the
// whole surface is admin-and-above, matching env vars and backups.

type DatastoreRowBase = {
  id: string;
  kind: string;
  name: string;
  slug: string;
  engineVersion: string;
  status: string;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  publicPort: number | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Allowlist serializer: `credentialsEncrypted` never leaves the API. */
function serializeDatastore(row: DatastoreRowBase) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    engineVersion: row.engineVersion,
    status: row.status,
    memoryLimitMb: row.memoryLimitMb,
    cpuLimit: row.cpuLimit != null ? Number(row.cpuLimit) : null,
    publicPort: row.publicPort,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function readCreds(enc: Uint8Array): DatastoreCredentials {
  const buf = Buffer.isBuffer(enc) ? enc : Buffer.from(enc);
  const vars = decryptJson(buf);
  return {
    username: vars.username,
    password: vars.password ?? "",
    database: vars.database
  };
}

function readEnv(enc: Buffer | Uint8Array | null): Record<string, string> {
  if (!enc || enc.length === 0) return {};
  return decryptJson(Buffer.isBuffer(enc) ? enc : Buffer.from(enc));
}

/**
 * Fresh credentials for a new datastore row. base64url is URL-safe. Also used
 * by restore (`backups.ts`): bundles carry no credentials, so every restored
 * datastore gets a new set.
 */
export function generateDatastoreCredentials(
  kind: DatastoreKind,
  slug: string
): Record<string, string> {
  const password = randomBytes(24).toString("base64url");
  if (kind === "postgres") {
    return { username: "sohwe", password, database: slug.replace(/-/g, "_") };
  }
  return { password };
}

function internalUrl(ds: {
  kind: string;
  slug: string;
  creds: DatastoreCredentials;
}): string {
  const kind = ds.kind as DatastoreKind;
  return buildDatastoreConnectionUrl(
    kind,
    ds.creds,
    datastoreContainerName(ds.slug),
    datastoreServicePort(kind)
  );
}

/**
 * Idempotently create an app's internal network — identical to the worker's
 * deploy-path call, because a datastore can be bound before the app has ever
 * deployed (the deploy will then reuse this network).
 */
async function ensureAppNetwork(appId: string): Promise<void> {
  try {
    await docker.createNetwork({
      Name: appInternalNetworkName(appId),
      Driver: "bridge",
      Internal: true,
      Labels: { "sohwe.managed": "true", "sohwe.app": appId }
    });
  } catch {
    // already exists (or Docker unavailable — the provision job retries this)
  }
}

/**
 * Best-effort connect/disconnect of a datastore container to an app network.
 * The container may not exist yet (bind before provision) — the provision job
 * connects every bound network itself, so a miss here is fine.
 */
async function connectDatastoreToApp(
  datastoreId: string,
  slug: string,
  appId: string,
  connect: boolean
): Promise<void> {
  try {
    const container = docker.getContainer(datastoreContainerName(slug));
    const info = await container.inspect();
    if (info.Config?.Labels?.[DATASTORE_LABEL] !== datastoreId) return;
    const net = docker.getNetwork(appInternalNetworkName(appId));
    if (connect) await net.connect({ Container: info.Id });
    else await net.disconnect({ Container: info.Id, Force: true });
  } catch {
    // best-effort
  }
}

export async function registerDatastoreRoutes(
  app: FastifyInstance,
  config: ApiConfig
) {
  // Routes whose request or response can carry credentials never log bodies.
  const secretOpts = { logLevel: "silent" as const };

  // Owned by this server instance and opened lazily; see applications.ts for
  // why a module-level queue would break every other instance in the process.
  let dsQueue: ReturnType<typeof createDatastoreQueue> | null = null;
  function queue(): ReturnType<typeof createDatastoreQueue> {
    dsQueue ??= createDatastoreQueue();
    return dsQueue;
  }
  app.addHook("onClose", async () => {
    await dsQueue?.close().catch(() => {});
  });

  app.get(
    "/api/datastores",
    { preHandler: [requireRole("admin")] },
    async (req) => {
      const u = req.user!;
      const rows = await prisma.datastore.findMany({
        where: { organizationId: u.organizationId },
        orderBy: { createdAt: "asc" }
      });
      return { datastores: rows.map(serializeDatastore) };
    }
  );

  app.post(
    "/api/datastores",
    {
      preHandler: [requireRole("admin")],
      schema: { body: CreateDatastoreSchema },
      ...secretOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const body = CreateDatastoreSchema.parse(req.body);

      const versions = datastoreEngineVersions(body.kind);
      const engineVersion = body.engineVersion ?? versions[0]!;
      if (!versions.includes(engineVersion)) {
        return reply.badRequest(
          `Unsupported ${body.kind} version. Supported: ${versions.join(", ")}`
        );
      }

      try {
        const row = await prisma.datastore.create({
          data: {
            organizationId: u.organizationId,
            kind: body.kind,
            name: body.name,
            slug: body.slug,
            engineVersion,
            status: "provisioning",
            memoryLimitMb: body.memoryLimitMb ?? null,
            cpuLimit: body.cpuLimit ?? null,
            credentialsEncrypted: encryptJson(
              generateDatastoreCredentials(body.kind, body.slug)
            )
          }
        });
        await queue().add(DATASTORE_PROVISION_JOB, { datastoreId: row.id });
        await recordAudit(req, {
          action: "datastore.create",
          targetType: "datastore",
          targetId: row.id,
          targetLabel: row.slug,
          metadata: { kind: row.kind, engineVersion: row.engineVersion }
        });
        return reply.status(201).send(serializeDatastore(row));
      } catch (e) {
        const code =
          e && typeof e === "object" && "code" in e ? String(e.code) : "";
        if (code === "P2002") {
          return reply
            .status(409)
            .send({ message: "A datastore with that slug already exists" });
        }
        throw e;
      }
    }
  );

  app.get(
    "/api/datastores/:id",
    { preHandler: [requireRole("admin")], schema: { params: IdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const row = await prisma.datastore.findFirst({
        where: { id, organizationId: u.organizationId },
        include: {
          bindings: {
            include: { application: { select: { name: true, slug: true } } },
            orderBy: { createdAt: "asc" }
          }
        }
      });
      if (!row) return reply.notFound();

      // Best-effort container state; "missing" is normal for idle datastores.
      let containerState = "missing";
      try {
        const info = await docker
          .getContainer(datastoreContainerName(row.slug))
          .inspect();
        if (info.Config?.Labels?.[DATASTORE_LABEL] === row.id) {
          containerState = info.State?.Status ?? "unknown";
        }
      } catch {
        // missing or Docker unavailable
      }

      return {
        ...serializeDatastore(row),
        containerState,
        bindings: row.bindings.map((b) => ({
          id: b.id,
          applicationId: b.applicationId,
          appName: b.application.name,
          appSlug: b.application.slug,
          envKeys: b.envKeys,
          createdAt: b.createdAt
        }))
      };
    }
  );

  app.post(
    "/api/datastores/:id/provision",
    { preHandler: [requireRole("admin")], schema: { params: IdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const row = await prisma.datastore.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!row) return reply.notFound();
      if (row.status !== "idle" && row.status !== "error") {
        return reply
          .status(409)
          .send({ message: `Cannot provision a datastore in status "${row.status}"` });
      }
      const updated = await prisma.datastore.update({
        where: { id: row.id },
        data: { status: "provisioning", errorMessage: null }
      });
      await queue().add(DATASTORE_PROVISION_JOB, { datastoreId: row.id });
      await recordAudit(req, {
        action: "datastore.provision",
        targetType: "datastore",
        targetId: row.id,
        targetLabel: row.slug
      });
      return serializeDatastore(updated);
    }
  );

  app.post(
    "/api/datastores/:id/rotate-password",
    { preHandler: [requireRole("admin")], schema: { params: IdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const row = await prisma.datastore.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!row) return reply.notFound();
      if (row.status !== "running") {
        return reply
          .status(409)
          .send({ message: "Password rotation needs a running datastore" });
      }
      await queue().add(DATASTORE_ROTATE_JOB, { datastoreId: row.id });
      await recordAudit(req, {
        action: "datastore.rotate_password",
        targetType: "datastore",
        targetId: row.id,
        targetLabel: row.slug
      });
      return reply.status(202).send({ ok: true });
    }
  );

  app.patch(
    "/api/datastores/:id/public-access",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: DatastorePublicAccessSchema }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const body = DatastorePublicAccessSchema.parse(req.body);
      const row = await prisma.datastore.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!row) return reply.notFound();
      if (row.status === "provisioning" || row.status === "deleting") {
        return reply
          .status(409)
          .send({ message: `Cannot change access while "${row.status}"` });
      }
      if (body.enabled === (row.publicPort != null)) {
        return serializeDatastore(row); // no-op
      }

      let updated = row;
      if (body.enabled) {
        // Stable random host port; the DB unique constraint arbitrates races.
        let assigned = false;
        for (let attempt = 0; attempt < 20 && !assigned; attempt++) {
          const port = randomInt(
            DATASTORE_PUBLIC_PORT_MIN,
            DATASTORE_PUBLIC_PORT_MAX + 1
          );
          try {
            updated = await prisma.datastore.update({
              where: { id: row.id },
              data: { publicPort: port }
            });
            assigned = true;
          } catch (e) {
            const code =
              e && typeof e === "object" && "code" in e ? String(e.code) : "";
            if (code !== "P2002") throw e;
          }
        }
        if (!assigned) {
          return reply
            .status(503)
            .send({ message: "Could not allocate a public port" });
        }
      } else {
        updated = await prisma.datastore.update({
          where: { id: row.id },
          data: { publicPort: null }
        });
      }

      // A running container must be recreated for port bindings to change; an
      // idle or errored one just keeps the setting for its next provision.
      if (row.status === "running") {
        updated = await prisma.datastore.update({
          where: { id: row.id },
          data: { status: "provisioning", errorMessage: null }
        });
        await queue().add(DATASTORE_PROVISION_JOB, { datastoreId: row.id });
      }

      await recordAudit(req, {
        action: "datastore.update",
        targetType: "datastore",
        targetId: row.id,
        targetLabel: row.slug,
        metadata: {
          publicAccess: body.enabled,
          publicPort: updated.publicPort
        }
      });
      return serializeDatastore(updated);
    }
  );

  app.get(
    "/api/datastores/:id/connection",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam },
      ...secretOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const row = await prisma.datastore.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!row) return reply.notFound();

      let creds: DatastoreCredentials;
      try {
        creds = readCreds(row.credentialsEncrypted);
      } catch {
        return reply
          .status(500)
          .send({ message: "Failed to read datastore credentials" });
      }

      const kind = row.kind as DatastoreKind;
      await recordAudit(req, {
        action: "datastore.reveal",
        targetType: "datastore",
        targetId: row.id,
        targetLabel: row.slug
      });
      return {
        host: datastoreContainerName(row.slug),
        port: datastoreServicePort(kind),
        username: creds.username ?? null,
        database: creds.database ?? null,
        password: creds.password,
        url: internalUrl({ kind: row.kind, slug: row.slug, creds }),
        publicUrl:
          row.publicPort != null
            ? buildDatastoreConnectionUrl(
                kind,
                creds,
                config.baseDomain,
                row.publicPort
              )
            : null
      };
    }
  );

  app.post(
    "/api/datastores/:id/bindings",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: CreateDatastoreBindingSchema },
      ...secretOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const body = CreateDatastoreBindingSchema.parse(req.body);

      const ds = await prisma.datastore.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!ds) return reply.notFound();
      const a = await prisma.application.findFirst({
        where: { id: body.applicationId, organizationId: u.organizationId },
        select: { id: true, slug: true, envVarsEncrypted: true }
      });
      if (!a) return reply.notFound("Application not found");

      const envKey =
        body.envKey ?? datastoreDefaultEnvKey(ds.kind as DatastoreKind);

      let creds: DatastoreCredentials;
      let before: Record<string, string>;
      try {
        creds = readCreds(ds.credentialsEncrypted);
        before = readEnv(a.envVarsEncrypted);
      } catch {
        return reply
          .status(500)
          .send({ message: "Failed to read encrypted configuration" });
      }
      const after = {
        ...before,
        [envKey]: internalUrl({ kind: ds.kind, slug: ds.slug, creds })
      };

      try {
        const binding = await prisma.$transaction(async (tx) => {
          const b = await tx.datastoreBinding.create({
            data: {
              datastoreId: ds.id,
              applicationId: a.id,
              envKeys: [envKey]
            }
          });
          await tx.application.update({
            where: { id: a.id },
            data: { envVarsEncrypted: encryptJson(after) }
          });
          return b;
        });

        // Docker side is best-effort: provision connects bound networks itself.
        await ensureAppNetwork(a.id);
        await connectDatastoreToApp(ds.id, ds.slug, a.id, true);

        await recordAudit(req, {
          action: "datastore.bind",
          targetType: "datastore",
          targetId: ds.id,
          targetLabel: `${ds.slug} -> ${a.slug}`,
          metadata: {
            applicationId: a.id,
            appSlug: a.slug,
            mode: "datastore-injection",
            ...envChangeMetadata(before, after)
          }
        });
        return reply.status(201).send({
          id: binding.id,
          applicationId: a.id,
          appSlug: a.slug,
          envKeys: binding.envKeys,
          note: "Takes effect on the app's next deploy"
        });
      } catch (e) {
        const code =
          e && typeof e === "object" && "code" in e ? String(e.code) : "";
        if (code === "P2002") {
          return reply
            .status(409)
            .send({ message: "This app is already bound to the datastore" });
        }
        throw e;
      }
    }
  );

  app.delete(
    "/api/datastores/:id/bindings/:bindingId",
    {
      preHandler: [requireRole("admin")],
      schema: { params: BindingParam },
      ...secretOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id, bindingId } = req.params as z.infer<typeof BindingParam>;

      const ds = await prisma.datastore.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!ds) return reply.notFound();
      const binding = await prisma.datastoreBinding.findFirst({
        where: { id: bindingId, datastoreId: ds.id },
        include: {
          application: { select: { id: true, slug: true, envVarsEncrypted: true } }
        }
      });
      if (!binding) return reply.notFound();

      // The recorded keys are removed unconditionally — the UI's confirm
      // dialog says so — even if the user has since repurposed one of them.
      let before: Record<string, string>;
      try {
        before = readEnv(binding.application.envVarsEncrypted);
      } catch {
        return reply
          .status(500)
          .send({ message: "Failed to read env var configuration" });
      }
      const after = { ...before };
      for (const key of binding.envKeys) delete after[key];

      await prisma.$transaction(async (tx) => {
        await tx.datastoreBinding.delete({ where: { id: binding.id } });
        await tx.application.update({
          where: { id: binding.application.id },
          data: {
            envVarsEncrypted:
              Object.keys(after).length === 0 ? null : encryptJson(after)
          }
        });
      });

      await connectDatastoreToApp(ds.id, ds.slug, binding.application.id, false);

      await recordAudit(req, {
        action: "datastore.unbind",
        targetType: "datastore",
        targetId: ds.id,
        targetLabel: `${ds.slug} -> ${binding.application.slug}`,
        metadata: {
          applicationId: binding.application.id,
          appSlug: binding.application.slug,
          mode: "datastore-injection",
          ...envChangeMetadata(before, after)
        }
      });
      return { ok: true };
    }
  );

  app.delete(
    "/api/datastores/:id",
    { preHandler: [requireRole("admin")], schema: { params: IdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const row = await prisma.datastore.findFirst({
        where: { id, organizationId: u.organizationId },
        include: { bindings: { select: { id: true } } }
      });
      if (!row) return reply.notFound();

      await prisma.datastore.update({
        where: { id: row.id },
        data: { status: "deleting" }
      });
      await queue().add(DATASTORE_DELETE_JOB, { datastoreId: row.id });
      await recordAudit(req, {
        action: "datastore.delete",
        targetType: "datastore",
        targetId: row.id,
        targetLabel: row.slug,
        metadata: { kind: row.kind, boundAppCount: row.bindings.length }
      });
      return reply.status(202).send({ ok: true });
    }
  );
}
