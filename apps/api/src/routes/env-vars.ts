import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import {
  EnvQuerySchema,
  EnvVarsPatchSchema,
  EnvVarsReplaceSchema
} from "@sohwe/types";
import {
  decryptJson,
  encryptJson,
  maskedPreview
} from "@sohwe/crypto";
import { z } from "zod";
import { envChangeMetadata, recordAudit } from "../audit";
import { requireRole } from "../rbac";

const IdParam = z.object({ id: z.string().uuid() });

// Env vars are admin-and-above end to end, including the non-revealing read:
// `maskedPreview` still exposes the shape and a few characters of every secret,
// which is more than the read-only member role should see.

function readEnv(
  enc: Buffer | null | undefined
): Record<string, string> {
  if (!enc || enc.length === 0) return {};
  return decryptJson(Buffer.isBuffer(enc) ? enc : Buffer.from(enc));
}

export async function registerEnvVarRoutes(app: FastifyInstance) {
  const envOpts = { logLevel: "silent" as const };

  app.get(
    "/api/applications/:id/env",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, querystring: EnvQuerySchema },
      ...envOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { reveal } = req.query as z.infer<typeof EnvQuerySchema>;

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true, slug: true, envVarsEncrypted: true }
      });
      if (!a) return reply.notFound();

      let map: Record<string, string>;
      try {
        map = readEnv(a.envVarsEncrypted);
      } catch {
        return reply
          .status(500)
          .send({ message: "Failed to read env var configuration" });
      }

      if (reveal) {
        // Reading plaintext secrets is itself an auditable act.
        await recordAudit(req, {
          action: "env.reveal",
          targetType: "env",
          targetId: a.id,
          targetLabel: a.slug,
          metadata: { keys: Object.keys(map).sort(), totalKeys: Object.keys(map).length }
        });
        return {
          keys: Object.keys(map).sort(),
          items: Object.entries(map)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => ({ key, value }))
        };
      }

      return {
        keys: Object.keys(map).sort(),
        items: Object.entries(map)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => ({ key, preview: maskedPreview(value) }))
      };
    }
  );

  app.put(
    "/api/applications/:id/env",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: EnvVarsReplaceSchema },
      ...envOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { vars } = EnvVarsReplaceSchema.parse(req.body);

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true, slug: true, envVarsEncrypted: true }
      });
      if (!a) return reply.notFound();

      // Read the previous set purely to describe the change in the audit trail;
      // an unreadable blob is being replaced wholesale either way.
      let before: Record<string, string> = {};
      try {
        before = readEnv(a.envVarsEncrypted);
      } catch {
        before = {};
      }

      const data =
        Object.keys(vars).length === 0
          ? { envVarsEncrypted: null }
          : { envVarsEncrypted: encryptJson(vars) };

      const updated = await prisma.application.update({
        where: { id },
        data
      });
      await recordAudit(req, {
        action: "env.update",
        targetType: "env",
        targetId: a.id,
        targetLabel: a.slug,
        metadata: { mode: "replace", ...envChangeMetadata(before, vars) }
      });
      return { ok: true, id: updated.id };
    }
  );

  app.patch(
    "/api/applications/:id/env",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: EnvVarsPatchSchema },
      ...envOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { set, unset } = EnvVarsPatchSchema.parse(req.body);

      if (
        (set == null || Object.keys(set).length === 0) &&
        (unset == null || unset.length === 0)
      ) {
        return reply.badRequest("Provide set and/or unset");
      }

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true, slug: true, envVarsEncrypted: true }
      });
      if (!a) return reply.notFound();

      let map: Record<string, string>;
      try {
        map = readEnv(a.envVarsEncrypted);
      } catch {
        return reply
          .status(500)
          .send({ message: "Failed to read env var configuration" });
      }

      const before = { ...map };
      if (set) for (const [k, v] of Object.entries(set)) map[k] = v;
      if (unset) for (const k of unset) delete map[k];

      const data =
        Object.keys(map).length === 0
          ? { envVarsEncrypted: null }
          : { envVarsEncrypted: encryptJson(map) };

      const updated = await prisma.application.update({
        where: { id },
        data
      });
      await recordAudit(req, {
        action: "env.update",
        targetType: "env",
        targetId: a.id,
        targetLabel: a.slug,
        metadata: { mode: "patch", ...envChangeMetadata(before, map) }
      });
      return { ok: true, id: updated.id };
    }
  );
}
