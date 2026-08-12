import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { prisma } from "@sohwe/db";
import {
  AcceptInvitationSchema,
  CreateInvitationSchema,
  INVITATION_TTL_DAYS,
  InvitationLookupSchema,
  UpdateMemberRoleSchema
} from "@sohwe/types";
import { z } from "zod";
import { recordAudit, recordAuditFor } from "../audit";
import type { ApiConfig } from "../env";
import { publicBaseUrl } from "../public-url";
import { AUTH_RATE_LIMIT } from "../rate-limit";
import { requireRole } from "../rbac";
import { issueSession } from "../session";

// Phase 6: organization members and invitations.
//
// Sohwe never sends email — a self-hosted instance would need an SMTP relay or
// a third-party API key just to add a second user. Instead an admin mints a
// single-use link and delivers it however they like. Only the SHA-256 of the
// token is stored, so the raw link exists exactly once, in the create response;
// a lost link is revoked and reissued rather than recovered.

const IdParam = z.object({ id: z.string().uuid() });

/** Bytes of entropy in an invitation token (43 base64url characters). */
const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

type InvitationRow = {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  invitedBy: { id: string; email: string; name: string | null } | null;
};

type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

function invitationStatus(inv: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): InvitationStatus {
  if (inv.acceptedAt) return "accepted";
  if (inv.revokedAt) return "revoked";
  if (inv.expiresAt.getTime() <= Date.now()) return "expired";
  return "pending";
}

/** Public shape of an invitation. `tokenHash` is never part of it. */
function serializeInvitation(inv: InvitationRow) {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    status: invitationStatus(inv),
    expiresAt: inv.expiresAt.toISOString(),
    acceptedAt: inv.acceptedAt?.toISOString() ?? null,
    revokedAt: inv.revokedAt?.toISOString() ?? null,
    createdAt: inv.createdAt.toISOString(),
    invitedBy: inv.invitedBy
      ? {
          id: inv.invitedBy.id,
          email: inv.invitedBy.email,
          name: inv.invitedBy.name
        }
      : null
  };
}

const invitationInclude = {
  invitedBy: { select: { id: true, email: true, name: true } }
} as const;

/** Join URL the admin copies out of the create response. */
function joinUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/join?token=${encodeURIComponent(token)}`;
}

export async function registerMemberRoutes(
  app: FastifyInstance,
  config: ApiConfig
) {
  // --- Members --------------------------------------------------------------

  // Every member may see who else is in the org; knowing your teammates is not
  // privileged, and the list carries no secrets.
  app.get(
    "/api/members",
    { preHandler: [requireRole("member")] },
    async (req) => {
      const u = req.user!;
      const rows = await prisma.user.findMany({
        where: { organizationId: u.organizationId },
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true
        }
      });
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        createdAt: r.createdAt.toISOString(),
        isSelf: r.id === u.id
      }));
    }
  );

  // Role changes are owner-only. An admin who could promote themselves to owner
  // would make the distinction meaningless.
  app.patch(
    "/api/members/:id/role",
    {
      preHandler: [requireRole("owner")],
      schema: { params: IdParam, body: UpdateMemberRoleSchema }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { role } = UpdateMemberRoleSchema.parse(req.body);

      const target = await prisma.user.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true, email: true, role: true }
      });
      if (!target) return reply.notFound();

      if (target.id === u.id) {
        return reply.badRequest(
          "You cannot change your own role. Ask another owner to do it."
        );
      }
      if (target.role === role) {
        return { id: target.id, email: target.email, role: target.role };
      }
      // Demoting the last owner would leave the org with nobody who can manage
      // roles, and no way back short of database surgery.
      if (target.role === "owner" && role !== "owner") {
        const owners = await prisma.user.count({
          where: { organizationId: u.organizationId, role: "owner" }
        });
        if (owners <= 1) {
          return reply.badRequest(
            "This is the only owner. Promote another owner first."
          );
        }
      }

      const updated = await prisma.user.update({
        where: { id: target.id },
        data: { role },
        select: { id: true, email: true, name: true, role: true }
      });
      // Role is read fresh from the DB on every request via the session lookup,
      // so the change takes effect on the target's next call without re-login.
      await recordAudit(req, {
        action: "member.role_change",
        targetType: "member",
        targetId: updated.id,
        targetLabel: updated.email,
        metadata: { from: target.role, to: role }
      });
      return updated;
    }
  );

  app.delete(
    "/api/members/:id",
    { preHandler: [requireRole("admin")], schema: { params: IdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;

      const target = await prisma.user.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true, email: true, role: true }
      });
      if (!target) return reply.notFound();

      if (target.id === u.id) {
        return reply.badRequest("You cannot remove your own account.");
      }
      if (target.role === "owner" && u.role !== "owner") {
        return reply.forbidden("Only an owner can remove another owner.");
      }
      if (target.role === "owner") {
        const owners = await prisma.user.count({
          where: { organizationId: u.organizationId, role: "owner" }
        });
        if (owners <= 1) {
          return reply.badRequest(
            "This is the only owner. Promote another owner first."
          );
        }
      }

      // Sessions cascade with the user row, so removal logs them out everywhere.
      await prisma.user.delete({ where: { id: target.id } });
      await recordAudit(req, {
        action: "member.remove",
        targetType: "member",
        targetId: target.id,
        targetLabel: target.email,
        metadata: { role: target.role }
      });
      return { ok: true };
    }
  );

  // --- Invitations ----------------------------------------------------------

  app.get(
    "/api/invitations",
    { preHandler: [requireRole("admin")] },
    async (req) => {
      const u = req.user!;
      const rows = await prisma.invitation.findMany({
        where: { organizationId: u.organizationId },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: invitationInclude
      });
      return rows.map(serializeInvitation);
    }
  );

  app.post(
    "/api/invitations",
    {
      preHandler: [requireRole("admin")],
      schema: { body: CreateInvitationSchema },
      // The response carries the one and only copy of the join token.
      logLevel: "silent"
    },
    async (req, reply) => {
      const u = req.user!;
      const { email, role } = CreateInvitationSchema.parse(req.body);

      // User emails are globally unique, so an existing account anywhere blocks
      // the invite regardless of which org it belongs to.
      const existing = await prisma.user.findUnique({
        where: { email },
        select: { id: true, organizationId: true }
      });
      if (existing) {
        return reply.conflict(
          existing.organizationId === u.organizationId
            ? "That person is already a member of this organization."
            : "An account already exists for that email address."
        );
      }

      const pending = await prisma.invitation.findFirst({
        where: {
          organizationId: u.organizationId,
          email,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() }
        },
        select: { id: true }
      });
      if (pending) {
        return reply.conflict(
          "An invitation for that email is already pending. Revoke it first to issue a new link."
        );
      }

      const token = randomBytes(TOKEN_BYTES).toString("base64url");
      const expiresAt = new Date(
        Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000
      );
      const created = await prisma.invitation.create({
        data: {
          organizationId: u.organizationId,
          email,
          role,
          tokenHash: hashToken(token),
          invitedById: u.id,
          expiresAt
        },
        include: invitationInclude
      });

      await recordAudit(req, {
        action: "member.invite",
        targetType: "invitation",
        targetId: created.id,
        targetLabel: email,
        metadata: { role }
      });

      return reply.status(201).send({
        invitation: serializeInvitation(created),
        // Shown once. Only the hash is stored, so this cannot be re-read later.
        token,
        acceptUrl: joinUrl(publicBaseUrl(req, config), token)
      });
    }
  );

  app.delete(
    "/api/invitations/:id",
    { preHandler: [requireRole("admin")], schema: { params: IdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;

      const inv = await prisma.invitation.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true, email: true, acceptedAt: true, revokedAt: true }
      });
      if (!inv) return reply.notFound();
      if (inv.acceptedAt) {
        return reply.badRequest(
          "That invitation was already accepted. Remove the member instead."
        );
      }
      if (!inv.revokedAt) {
        await prisma.invitation.update({
          where: { id: inv.id },
          data: { revokedAt: new Date() }
        });
        await recordAudit(req, {
          action: "member.invite_revoke",
          targetType: "invitation",
          targetId: inv.id,
          targetLabel: inv.email
        });
      }
      return { ok: true };
    }
  );

  // --- Public redemption ----------------------------------------------------
  //
  // Both routes are pre-auth (the invitee has no account yet) and therefore
  // rate limited, like login and setup unlock.

  app.get(
    "/api/invitations/lookup",
    {
      schema: { querystring: InvitationLookupSchema },
      config: AUTH_RATE_LIMIT,
      logLevel: "silent"
    },
    async (req, reply) => {
      const { token } = req.query as z.infer<typeof InvitationLookupSchema>;
      const inv = await prisma.invitation.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
          email: true,
          role: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          organization: { select: { name: true } }
        }
      });
      // A bad token and a spent token are both "this link does not work"; there
      // is nothing for an unauthenticated caller to learn from the difference.
      if (!inv) return reply.notFound("This invitation link is not valid.");
      const status = invitationStatus(inv);
      if (status !== "pending") {
        return reply.gone(
          status === "accepted"
            ? "This invitation has already been used. Sign in instead."
            : "This invitation is no longer valid. Ask for a new link."
        );
      }
      return {
        email: inv.email,
        role: inv.role,
        organizationName: inv.organization.name,
        expiresAt: inv.expiresAt.toISOString()
      };
    }
  );

  app.post(
    "/api/invitations/accept",
    {
      schema: { body: AcceptInvitationSchema },
      config: AUTH_RATE_LIMIT,
      // Carries a password.
      logLevel: "silent"
    },
    async (req, reply) => {
      const { token, name, password } = AcceptInvitationSchema.parse(req.body);
      const inv = await prisma.invitation.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
          id: true,
          email: true,
          role: true,
          organizationId: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true
        }
      });
      if (!inv) return reply.notFound("This invitation link is not valid.");
      if (invitationStatus(inv) !== "pending") {
        return reply.gone("This invitation is no longer valid.");
      }

      const passwordHash = await argon2.hash(password);

      // Claim the row and create the account together: two people opening the
      // same link at once must not produce two accounts from one invitation.
      // The conditional updateMany is the lock — exactly one caller sees
      // count === 1.
      let created: { id: string; email: string; name: string | null } | null;
      try {
        created = await prisma.$transaction(async (tx) => {
          const claimed = await tx.invitation.updateMany({
            where: {
              id: inv.id,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: new Date() }
            },
            data: { acceptedAt: new Date() }
          });
          if (claimed.count !== 1) return null;

          const user = await tx.user.create({
            data: {
              email: inv.email,
              name,
              passwordHash,
              role: inv.role,
              organizationId: inv.organizationId
            },
            select: { id: true, email: true, name: true }
          });
          await tx.invitation.update({
            where: { id: inv.id },
            data: { acceptedById: user.id }
          });
          return user;
        });
      } catch (err) {
        // Unique violation on email: an account appeared between the lookup and
        // the insert.
        if ((err as { code?: string }).code === "P2002") {
          return reply.conflict(
            "An account already exists for that email address. Sign in instead."
          );
        }
        throw err;
      }
      if (!created) {
        return reply.gone("This invitation is no longer valid.");
      }

      await issueSession(reply, created.id);
      await recordAuditFor(
        {
          organizationId: inv.organizationId,
          actorId: created.id,
          actorEmail: created.email,
          ip: req.ip
        },
        {
          action: "member.join",
          targetType: "member",
          targetId: created.id,
          targetLabel: created.email,
          metadata: { role: inv.role, invitationId: inv.id }
        },
        req.log
      );

      return reply.status(201).send({
        id: created.id,
        email: created.email,
        name: created.name,
        role: inv.role
      });
    }
  );
}
