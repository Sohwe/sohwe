import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
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

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

async function deleteExpiredSessions(log: FastifyBaseLogger): Promise<void> {
  try {
    const { count } = await prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } }
    });
    if (count > 0) log.info({ count }, "Deleted expired sessions");
  } catch (err) {
    // Non-fatal: a failed sweep just means the rows are reclaimed next tick.
    log.warn({ err }, "Expired session cleanup failed");
  }
}

/**
 * Periodically delete expired session rows. Sessions are already rejected at
 * read time once past `expiresAt`; this only reclaims storage so the table
 * doesn't accumulate 30-day-lived rows forever. Returns a stop function.
 */
export function startSessionCleanup(log: FastifyBaseLogger): () => void {
  void deleteExpiredSessions(log);
  const timer = setInterval(() => {
    void deleteExpiredSessions(log);
  }, SESSION_CLEANUP_INTERVAL_MS);
  // Don't keep the process alive just for the sweep.
  timer.unref();
  return () => clearInterval(timer);
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}
