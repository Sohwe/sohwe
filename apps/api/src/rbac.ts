import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@sohwe/types";
import { authPreHandler } from "./session";

// Role checks for Phase 6. Sohwe has three org roles and a strict ordering, so
// every guard is "at least this role" rather than a per-permission matrix:
//
//   owner  > admin > member
//
// - member: read the org, deploy and roll back existing apps
// - admin:  everything operational (apps, env vars, volumes, backups, Git,
//           invites, removing members) but cannot touch owners
// - owner:  additionally manages roles and other owners
//
// Anything that can surface a secret is admin-or-higher even when it is only a
// read: env var values and masked previews, the container file browser (an app
// can hold credentials on disk or in /proc/self/environ), and backup
// export/restore (bundles carry re-encrypted env vars).

const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

/**
 * Numeric privilege of a stored role string. Unknown values rank 0 — a role
 * this build does not understand gets no privileges rather than the benefit of
 * the doubt, which keeps a downgrade or a hand-edited row from escalating.
 */
export function roleRank(role: string): number {
  return RANK[role as Role] ?? 0;
}

/** Whether `role` is at least as privileged as `min`. */
export function hasRole(role: string, min: Role): boolean {
  return roleRank(role) >= RANK[min];
}

/**
 * Fastify preHandler enforcing a minimum role. Authenticates first when it runs
 * alone, so `preHandler: [requireRole("admin")]` is sufficient on its own and
 * a route can never end up role-checked but unauthenticated.
 */
export function requireRole(min: Role) {
  return async function roleGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.user) {
      await authPreHandler(req, reply);
      // authPreHandler already sent 401; returning the reply stops the chain.
      if (!req.user) return reply;
    }
    if (!hasRole(req.user.role, min)) {
      return reply.forbidden(`This action requires the ${min} role or higher.`);
    }
    return undefined;
  };
}
