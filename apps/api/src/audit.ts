import type { FastifyRequest } from "fastify";
import { Prisma, prisma } from "@sohwe/db";

// Append-only activity trail (Phase 6). Two rules govern every call site:
//
// 1. Nothing secret goes in. Env var and build variable events carry key
//    *names* and counts, never values; backup events carry destination and app
//    counts, never passphrases; GitHub events carry the app slug, never the PEM
//    or webhook secret.
// 2. Recording is best-effort. An audit write must never turn a successful
//    action into a failed request, so every helper here swallows its errors and
//    logs a warning instead.

export type AuditTargetType =
  | "application"
  | "deployment"
  | "volume"
  | "env"
  | "build_args"
  | "alert_destination"
  | "member"
  | "invitation"
  | "backup"
  | "github"
  | "datastore"
  | "dns"
  | "domain"
  | "host_fs"
  | "organization";

/**
 * Dotted event names. Kept as a closed union so the audit filter UI and the
 * tests stay in step with what the routes actually emit.
 */
export type AuditAction =
  | "application.create"
  | "application.update"
  | "application.delete"
  | "deployment.deploy"
  | "deployment.rollback"
  | "env.update"
  | "env.reveal"
  | "build_args.update"
  | "build_args.reveal"
  | "volume.create"
  | "volume.delete"
  | "alert_destination.create"
  | "alert_destination.update"
  | "alert_destination.delete"
  | "backup.export"
  | "backup.restore"
  | "backup.destination.create"
  | "backup.destination.delete"
  | "backup.schedule.create"
  | "backup.schedule.update"
  | "backup.schedule.delete"
  | "datastore.create"
  | "datastore.update"
  | "datastore.delete"
  | "datastore.provision"
  | "datastore.rotate_password"
  | "datastore.reveal"
  | "datastore.bind"
  | "datastore.unbind"
  | "dns.credentials.set"
  | "dns.credentials.delete"
  | "dns.record.apply"
  | "domain.create"
  | "domain.delete"
  | "domain.primary"
  | "domain.redirect"
  | "github.connect"
  | "github.install"
  | "github.disconnect"
  | "host_fs.list"
  | "host_fs.read"
  | "member.invite"
  | "member.invite_revoke"
  | "member.join"
  | "member.role_change"
  | "member.remove";

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  "application.create",
  "application.update",
  "application.delete",
  "deployment.deploy",
  "deployment.rollback",
  "env.update",
  "env.reveal",
  "build_args.update",
  "build_args.reveal",
  "volume.create",
  "volume.delete",
  "alert_destination.create",
  "alert_destination.update",
  "alert_destination.delete",
  "backup.export",
  "backup.restore",
  "backup.destination.create",
  "backup.destination.delete",
  "backup.schedule.create",
  "backup.schedule.update",
  "backup.schedule.delete",
  "datastore.create",
  "datastore.update",
  "datastore.delete",
  "datastore.provision",
  "datastore.rotate_password",
  "datastore.reveal",
  "datastore.bind",
  "datastore.unbind",
  "dns.credentials.set",
  "dns.credentials.delete",
  "dns.record.apply",
  "domain.create",
  "domain.delete",
  "domain.primary",
  "domain.redirect",
  "github.connect",
  "github.install",
  "github.disconnect",
  "host_fs.list",
  "host_fs.read",
  "member.invite",
  "member.invite_revoke",
  "member.join",
  "member.role_change",
  "member.remove"
] as const;

export type AuditEntry = {
  action: AuditAction;
  targetType: AuditTargetType;
  targetId?: string | null;
  /** App slug, member email, destination name — whatever reads well in the UI. */
  targetLabel?: string | null;
  metadata?: Record<string, unknown> | null;
};

type AuditActor = {
  organizationId: string;
  actorId: string | null;
  actorEmail: string;
  ip?: string | null;
};

/**
 * Write one audit row. Never throws: a failed insert is logged and dropped.
 */
export async function recordAuditFor(
  actor: AuditActor,
  entry: AuditEntry,
  log?: { warn(obj: unknown, msg: string): void }
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        actorEmail: actor.actorEmail,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        targetLabel: entry.targetLabel ?? null,
        metadata:
          entry.metadata == null
            ? Prisma.DbNull
            : (entry.metadata as Prisma.InputJsonValue),
        ip: actor.ip ?? null
      }
    });
  } catch (err) {
    log?.warn({ err, action: entry.action }, "Failed to record audit event");
  }
}

/**
 * Record an event attributed to the authenticated caller. Safe to `void` at the
 * call site; a request that got this far has already done the real work.
 */
export async function recordAudit(
  req: FastifyRequest,
  entry: AuditEntry
): Promise<void> {
  const u = req.user;
  if (!u) return;
  await recordAuditFor(
    {
      organizationId: u.organizationId,
      actorId: u.id,
      actorEmail: u.email,
      ip: req.ip
    },
    entry,
    req.log
  );
}

/**
 * Summarize a variable-map change without leaking values: which keys were
 * added, removed, or had their value changed, plus the resulting total. Used
 * for both runtime env vars and build variables.
 */
export function envChangeMetadata(
  before: Record<string, string>,
  after: Record<string, string>
): Record<string, unknown> {
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  const added = afterKeys.filter((k) => !(k in before)).sort();
  const removed = beforeKeys.filter((k) => !(k in after)).sort();
  const changed = afterKeys
    .filter((k) => k in before && before[k] !== after[k])
    .sort();
  return {
    added,
    removed,
    changed,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    totalKeys: afterKeys.length
  };
}
