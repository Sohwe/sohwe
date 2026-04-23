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
import { authPreHandler } from "../session";

const IdParam = z.object({ id: z.string().uuid() });

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
      preHandler: [authPreHandler],
      schema: { params: IdParam, querystring: EnvQuerySchema },
      ...envOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { reveal } = req.query as z.infer<typeof EnvQuerySchema>;

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true, envVarsEncrypted: true }
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
      preHandler: [authPreHandler],
      schema: { params: IdParam, body: EnvVarsReplaceSchema },
      ...envOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { vars } = EnvVarsReplaceSchema.parse(req.body);

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!a) return reply.notFound();

      const data =
        Object.keys(vars).length === 0
          ? { envVarsEncrypted: null }
          : { envVarsEncrypted: encryptJson(vars) };

      const updated = await prisma.application.update({
        where: { id },
        data
      });
      return { ok: true, id: updated.id };
    }
  );

  app.patch(
    "/api/applications/:id/env",
    {
      preHandler: [authPreHandler],
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
        select: { id: true, envVarsEncrypted: true }
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
      return { ok: true, id: updated.id };
    }
  );
}
