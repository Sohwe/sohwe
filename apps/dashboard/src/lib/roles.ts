import type { Me } from "@/lib/types";

// Client-side mirror of `apps/api/src/rbac.ts`. This exists only to hide
// controls the caller cannot use — the API enforces the same ordering on every
// request, so a stale or tampered role here changes what is drawn, never what
// is allowed.

export const ROLE_ORDER = ["member", "admin", "owner"] as const;
export type Role = (typeof ROLE_ORDER)[number];

const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

/** Unknown roles rank 0, matching the server's fail-closed behavior. */
export function hasRole(role: string | undefined, min: Role): boolean {
  if (!role) return false;
  return (RANK[role as Role] ?? 0) >= RANK[min];
}

export function isAdmin(me: Me | null | undefined): boolean {
  return hasRole(me?.role, "admin");
}

export function isOwner(me: Me | null | undefined): boolean {
  return hasRole(me?.role, "owner");
}

export const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member"
};

export const ROLE_DESCRIPTION: Record<string, string> = {
  owner: "Full control, including roles and other owners.",
  admin: "Manage apps, variables, volumes, backups, Git, and members.",
  member: "Read-only, plus deploying and rolling back existing apps."
};
