import { prisma } from "@sohwe/db";

/**
 * Recording inbound GitHub webhook deliveries.
 *
 * A push that fails to deploy is otherwise invisible: the delivery is accepted
 * or rejected in a request the operator never sees, and the only trace is a
 * server log line. This keeps a short, bounded history that the Git settings
 * page can show — enough to tell "GitHub never called us" from "the signature
 * was wrong" from "no app tracks that branch".
 *
 * Nothing derived from an unverified payload is stored. Rejected rows hold only
 * the clear-text headers GitHub sends and the outcome.
 */

export type DeliveryOutcome =
  /** Signature did not match any connected App's secret. */
  | "rejected"
  /** Verified, but nothing to do (ping, unrelated event, no tracking app). */
  | "ignored"
  /** Verified and at least one deploy was enqueued. */
  | "accepted"
  /** Verified, but handling threw. */
  | "error";

export type DeliveryRecord = {
  organizationId: string | null;
  deliveryId: string | null;
  event: string;
  verified: boolean;
  outcome: DeliveryOutcome;
  detail?: string | null;
  repoFullName?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  deployCount?: number;
};

/** Rows kept per organization (unattributed rows form their own bucket). */
export const WEBHOOK_DELIVERY_HISTORY = 200;

/** Cap on the stored `detail` string. */
const MAX_DETAIL = 500;

/**
 * Persist one delivery and trim the history.
 *
 * Best-effort by design: this is a debugging aid, and a failure to write it
 * must never turn a delivery that would have deployed into a 500.
 */
export async function recordWebhookDelivery(
  record: DeliveryRecord,
  log?: { warn(obj: object, msg: string): void }
): Promise<void> {
  try {
    await prisma.webhookDelivery.create({
      data: {
        organizationId: record.organizationId,
        deliveryId: record.deliveryId,
        event: record.event,
        verified: record.verified,
        outcome: record.outcome,
        detail: record.detail ? record.detail.slice(0, MAX_DETAIL) : null,
        repoFullName: record.repoFullName ?? null,
        branch: record.branch ?? null,
        commitSha: record.commitSha ?? null,
        deployCount: record.deployCount ?? 0
      }
    });
    await pruneWebhookDeliveries(record.organizationId);
  } catch (err) {
    log?.warn({ err }, "Failed to record GitHub webhook delivery");
  }
}

/**
 * Keep the newest `WEBHOOK_DELIVERY_HISTORY` rows for one organization.
 *
 * Scoped rather than global so a noisy organization cannot evict another's
 * history. `IS NOT DISTINCT FROM` puts unattributed (null-org) rows in their
 * own bucket instead of matching nothing.
 */
export async function pruneWebhookDeliveries(
  organizationId: string | null
): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "webhook_deliveries"
    WHERE "id" IN (
      SELECT "id" FROM "webhook_deliveries"
      WHERE "organization_id" IS NOT DISTINCT FROM ${organizationId}
      ORDER BY "created_at" DESC
      OFFSET ${WEBHOOK_DELIVERY_HISTORY}
    )
  `;
}
