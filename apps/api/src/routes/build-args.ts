import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import {
  BuildArgsPatchSchema,
  BuildArgsReplaceSchema,
  EnvQuerySchema
} from "@sohwe/types";
import { z } from "zod";
import { envChangeMetadata, recordAudit } from "../audit";
import { requireRole } from "../rbac";
import {
  applyVarPatch,
  encodeVarBlob,
  maskedListing,
  readVarBlob,
  revealedListing
} from "./variable-store";

const IdParam = z.object({ id: z.string().uuid() });

// Build variables reach `nixpacks build --env` / `docker build --build-arg`,
// which bakes them into image layers. They are still admin-and-above and still
// masked by default: users put registry tokens here, and "visible to anyone who
// can pull the image" is not a reason to also show them to the member role.

export async function registerBuildArgRoutes(app: FastifyInstance) {
  const buildArgOpts = { logLevel: "silent" as const };

  app.get(
    "/api/applications/:id/build-args",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, querystring: EnvQuerySchema },
      ...buildArgOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { reveal } = req.query as z.infer<typeof EnvQuerySchema>;

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true, slug: true, buildArgsEncrypted: true }
      });
      if (!a) return reply.notFound();

      let map: Record<string, string>;
      try {
        map = readVarBlob(a.buildArgsEncrypted);
      } catch {
        return reply
          .status(500)
          .send({ message: "Failed to read build variable configuration" });
      }

      if (reveal) {
        await recordAudit(req, {
          action: "build_args.reveal",
          targetType: "build_args",
          targetId: a.id,
          targetLabel: a.slug,
          metadata: {
            keys: Object.keys(map).sort(),
            totalKeys: Object.keys(map).length
          }
        });
        return revealedListing(map);
      }

      return maskedListing(map);
    }
  );

  app.put(
    "/api/applications/:id/build-args",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: BuildArgsReplaceSchema },
      ...buildArgOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { vars } = BuildArgsReplaceSchema.parse(req.body);

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true, slug: true, buildArgsEncrypted: true }
      });
      if (!a) return reply.notFound();

      // Only to describe the change in the audit trail; the blob is being
      // replaced wholesale whether or not it can still be read.
      let before: Record<string, string> = {};
      try {
        before = readVarBlob(a.buildArgsEncrypted);
      } catch {
        before = {};
      }

      const updated = await prisma.application.update({
        where: { id },
        data: { buildArgsEncrypted: encodeVarBlob(vars) }
      });
      await recordAudit(req, {
        action: "build_args.update",
        targetType: "build_args",
        targetId: a.id,
        targetLabel: a.slug,
        metadata: { mode: "replace", ...envChangeMetadata(before, vars) }
      });
      return { ok: true, id: updated.id };
    }
  );

  app.patch(
    "/api/applications/:id/build-args",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: BuildArgsPatchSchema },
      ...buildArgOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { set, unset } = BuildArgsPatchSchema.parse(req.body);

      if (
        (set == null || Object.keys(set).length === 0) &&
        (unset == null || unset.length === 0)
      ) {
        return reply.badRequest("Provide set and/or unset");
      }

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true, slug: true, buildArgsEncrypted: true }
      });
      if (!a) return reply.notFound();

      let before: Record<string, string>;
      try {
        before = readVarBlob(a.buildArgsEncrypted);
      } catch {
        return reply
          .status(500)
          .send({ message: "Failed to read build variable configuration" });
      }

      const map = applyVarPatch(before, set, unset);

      const updated = await prisma.application.update({
        where: { id },
        data: { buildArgsEncrypted: encodeVarBlob(map) }
      });
      await recordAudit(req, {
        action: "build_args.update",
        targetType: "build_args",
        targetId: a.id,
        targetLabel: a.slug,
        metadata: { mode: "patch", ...envChangeMetadata(before, map) }
      });
      return { ok: true, id: updated.id };
    }
  );
}
