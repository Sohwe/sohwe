import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import {
  CreateAlertDestinationSchema,
  UpdateAlertDestinationSchema
} from "@sohwe/types";
import { z } from "zod";
import { recordAudit } from "../audit";
import { requireRole } from "../rbac";

// Admin-and-above throughout, reads included: a Discord/Slack webhook URL is a
// bearer credential for posting into someone's channel.

const IdParam = z.object({ id: z.string().uuid() });
const DestIdParam = z.object({
  id: z.string().uuid(),
  destId: z.string().uuid()
});

type AlertDestinationRow = {
  id: string;
  type: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function serializeAlertDestination(d: AlertDestinationRow) {
  return {
    id: d.id,
    type: d.type,
    name: d.name,
    url: d.url,
    enabled: d.enabled,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt
  };
}

/** Per-app webhook crash-alert destinations (Phase 4). */
export async function registerAlertDestinationRoutes(app: FastifyInstance) {
  app.get(
    "/api/applications/:id/alert-destinations",
    { preHandler: [requireRole("admin")], schema: { params: IdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true }
      });
      if (!a) return reply.notFound();
      const rows = await prisma.alertDestination.findMany({
        where: { applicationId: id },
        orderBy: { createdAt: "asc" }
      });
      return { destinations: rows.map(serializeAlertDestination) };
    }
  );

  app.post(
    "/api/applications/:id/alert-destinations",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: CreateAlertDestinationSchema }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const body = CreateAlertDestinationSchema.parse(req.body);

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true }
      });
      if (!a) return reply.notFound();

      const row = await prisma.alertDestination.create({
        data: {
          applicationId: id,
          type: body.type,
          name: body.name,
          url: body.url,
          enabled: body.enabled
        }
      });
      await recordAudit(req, {
        action: "alert_destination.create",
        targetType: "alert_destination",
        targetId: row.id,
        targetLabel: row.name,
        // The webhook URL itself stays out of the trail.
        metadata: { applicationId: a.id, type: row.type, enabled: row.enabled }
      });
      return reply.status(201).send(serializeAlertDestination(row));
    }
  );

  app.patch(
    "/api/applications/:id/alert-destinations/:destId",
    {
      preHandler: [requireRole("admin")],
      schema: { params: DestIdParam, body: UpdateAlertDestinationSchema }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id, destId } = req.params as z.infer<typeof DestIdParam>;
      const body = UpdateAlertDestinationSchema.parse(req.body);

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true }
      });
      if (!a) return reply.notFound();

      const existing = await prisma.alertDestination.findFirst({
        where: { id: destId, applicationId: id }
      });
      if (!existing) return reply.notFound();

      const data: Record<string, unknown> = {};
      if (body.type !== undefined) data.type = body.type;
      if (body.name !== undefined) data.name = body.name;
      if (body.url !== undefined) data.url = body.url;
      if (body.enabled !== undefined) data.enabled = body.enabled;

      const row = await prisma.alertDestination.update({
        where: { id: destId },
        data
      });
      await recordAudit(req, {
        action: "alert_destination.update",
        targetType: "alert_destination",
        targetId: row.id,
        targetLabel: row.name,
        metadata: { applicationId: a.id, fields: Object.keys(data).sort() }
      });
      return serializeAlertDestination(row);
    }
  );

  app.delete(
    "/api/applications/:id/alert-destinations/:destId",
    { preHandler: [requireRole("admin")], schema: { params: DestIdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { id, destId } = req.params as z.infer<typeof DestIdParam>;

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true }
      });
      if (!a) return reply.notFound();

      const existing = await prisma.alertDestination.findFirst({
        where: { id: destId, applicationId: id }
      });
      if (!existing) return reply.notFound();

      await prisma.alertDestination.delete({ where: { id: destId } });
      await recordAudit(req, {
        action: "alert_destination.delete",
        targetType: "alert_destination",
        targetId: existing.id,
        targetLabel: existing.name,
        metadata: { applicationId: a.id, type: existing.type }
      });
      return { ok: true };
    }
  );
}
