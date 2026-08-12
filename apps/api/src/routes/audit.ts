import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import { AuditLogQuerySchema } from "@sohwe/types";
import { z } from "zod";
import { AUDIT_ACTIONS } from "../audit";
import { requireRole } from "../rbac";

// Read side of the Phase 6 audit trail. Admin-and-above: the log is org-wide
// activity attributed to named people, which is more than a member needs.
// Writes happen at the call sites in the other route modules; there is no
// endpoint that creates audit rows.

export async function registerAuditRoutes(app: FastifyInstance) {
  app.get(
    "/api/audit-logs",
    {
      preHandler: [requireRole("admin")],
      schema: { querystring: AuditLogQuerySchema }
    },
    async (req) => {
      const u = req.user!;
      const q = req.query as z.infer<typeof AuditLogQuerySchema>;

      const rows = await prisma.auditLog.findMany({
        where: {
          organizationId: u.organizationId,
          ...(q.action ? { action: q.action } : {}),
          ...(q.targetType ? { targetType: q.targetType } : {}),
          ...(q.targetId ? { targetId: q.targetId } : {}),
          ...(q.actorId ? { actorId: q.actorId } : {})
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        // One extra row tells us whether another page exists without a count().
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          action: true,
          targetType: true,
          targetId: true,
          targetLabel: true,
          metadata: true,
          ip: true,
          createdAt: true,
          actorId: true,
          actorEmail: true,
          actor: { select: { id: true, name: true, email: true } }
        }
      });

      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({
          id: r.id,
          action: r.action,
          targetType: r.targetType,
          targetId: r.targetId,
          targetLabel: r.targetLabel,
          metadata: r.metadata ?? null,
          ip: r.ip,
          createdAt: r.createdAt.toISOString(),
          actor: {
            id: r.actorId,
            // actorEmail survives the user row; actor.name is null once removed.
            email: r.actorEmail,
            name: r.actor?.name ?? null,
            deleted: r.actorId === null || r.actor === null
          }
        })),
        nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null
      };
    }
  );

  /** Vocabulary for the audit filter UI: every action this build can emit. */
  app.get(
    "/api/audit-logs/actions",
    { preHandler: [requireRole("admin")] },
    async () => ({ actions: AUDIT_ACTIONS })
  );
}
