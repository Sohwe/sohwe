import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@sohwe/db";

export type AuthedUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  organizationId: string;
  organization: { id: string; name: string };
};

export async function getSessionUser(
  req: FastifyRequest
): Promise<AuthedUser | null> {
  const sessionId = req.cookies.sohwe_session;
  if (!sessionId) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { include: { organization: true } } }
  });
  if (!session || session.expiresAt < new Date()) {
    return null;
  }
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    organizationId: session.user.organizationId,
    organization: {
      id: session.user.organization.id,
      name: session.user.organization.name
    }
  };
}

export async function authPreHandler(
  req: FastifyRequest,
  reply: FastifyReply
) {
  const u = await getSessionUser(req);
  if (!u) {
    return reply.unauthorized();
  }
  req.user = u;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}
