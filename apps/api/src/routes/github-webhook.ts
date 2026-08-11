import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import { createQueue } from "@sohwe/queue";
import {
  clearInstallationTokenCache,
  parsePushEvent,
  verifyWebhookSignature
} from "@sohwe/github";
import { decryptAppCredentials } from "@sohwe/github/resolve";
import { recordWebhookDelivery } from "../webhook-deliveries";
import { GITHUB_WEBHOOK_PATH } from "./github";

// Inbound GitHub webhook (Phase 5). Unauthenticated by nature — the
// X-Hub-Signature-256 HMAC is the only thing standing between a delivery and a
// deploy, so nothing in the payload is trusted until the signature verifies.
//
// Which App signed a delivery cannot be known before verification (the payload
// itself is untrusted), so the handler tries each connected App's secret. A
// self-hosted instance has one, so this is a single HMAC in practice.

const deployQueue = createQueue();

// Generous, but bounded: a busy monorepo can deliver a burst of pushes, while
// an unauthenticated public endpoint still needs a ceiling.
const WEBHOOK_RATE_LIMIT = {
  rateLimit: { max: 300, timeWindow: "1 minute" }
} as const;

/** Max bytes accepted from a delivery; GitHub caps payloads at 25 MB. */
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

type VerifiedDelivery = {
  organizationId: string;
  appId: number;
  payload: unknown;
};

async function verifyDelivery(
  rawBody: Buffer,
  signature: string | undefined
): Promise<VerifiedDelivery | null> {
  const rows = await prisma.gitHubApp.findMany({
    select: { organizationId: true, appId: true, credentialsEncrypted: true }
  });

  for (const row of rows) {
    let secret: string;
    try {
      secret = decryptAppCredentials(row.credentialsEncrypted).webhookSecret;
    } catch {
      // A row we can no longer decrypt (rotated instance key) can't verify
      // anything; skip it rather than failing every delivery.
      continue;
    }
    if (!verifyWebhookSignature(secret, rawBody, signature)) continue;

    try {
      return {
        organizationId: row.organizationId,
        appId: row.appId,
        payload: JSON.parse(rawBody.toString("utf8")) as unknown
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Why a verified push enqueued nothing. Distinguishing "no app uses this repo"
 * from "an app uses it but tracks another branch" from "auto-deploy is off" is
 * the whole point of the delivery log — those three look identical otherwise.
 */
async function explainNoDeploys(
  organizationId: string,
  push: { repoFullName: string; branch: string }
): Promise<string> {
  const candidates = await prisma.application.findMany({
    where: { organizationId, repoFullName: push.repoFullName },
    select: { name: true, gitBranch: true, autoDeploy: true }
  });
  if (candidates.length === 0) {
    return `No app is linked to ${push.repoFullName}.`;
  }
  const onBranch = candidates.filter((a) => a.gitBranch === push.branch);
  if (onBranch.length === 0) {
    const tracked = [...new Set(candidates.map((a) => a.gitBranch))].join(", ");
    return `Apps linked to ${push.repoFullName} track ${tracked}, not ${push.branch}.`;
  }
  const names = onBranch.map((a) => a.name).join(", ");
  return `Auto-deploy is off for ${names}.`;
}

/** Queue a deploy for every auto-deploy app tracking this repo and branch. */
async function enqueuePushDeploys(
  organizationId: string,
  push: { repoFullName: string; branch: string; headSha: string; headMessage: string | null }
): Promise<string[]> {
  const apps = await prisma.application.findMany({
    where: {
      organizationId,
      repoFullName: push.repoFullName,
      gitBranch: push.branch,
      autoDeploy: true
    },
    select: { id: true }
  });

  const deploymentIds: string[] = [];
  for (const app of apps) {
    const deployment = await prisma.deployment.create({
      data: {
        applicationId: app.id,
        status: "pending",
        trigger: "push",
        commitSha: push.headSha || null,
        commitMessage: push.headMessage
      }
    });
    await deployQueue.add(
      "deploy",
      { deploymentId: deployment.id, applicationId: app.id },
      { jobId: deployment.id, removeOnComplete: 200, removeOnFail: 100 }
    );
    deploymentIds.push(deployment.id);
  }
  return deploymentIds;
}

export async function registerGitHubWebhookRoutes(app: FastifyInstance) {
  // Opened at module load; close it with the server so the process can exit.
  app.addHook("onClose", async () => {
    await deployQueue.close().catch(() => {});
  });

  // Encapsulated so the raw-body parser applies to this route only; every other
  // JSON endpoint keeps Fastify's normal object parsing.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: MAX_PAYLOAD_BYTES },
      (_req, body, done) => {
        // Signature verification needs the exact bytes GitHub signed, so the
        // body is handed through unparsed.
        done(null, body);
      }
    );

    scope.post(
      GITHUB_WEBHOOK_PATH,
      { config: WEBHOOK_RATE_LIMIT },
      async (req, reply) => {
        const rawBody = req.body;
        if (!Buffer.isBuffer(rawBody)) {
          return reply.badRequest("Expected a raw JSON body");
        }

        const eventHeader = req.headers["x-github-event"];
        const event = typeof eventHeader === "string" ? eventHeader : "";
        const idHeader = req.headers["x-github-delivery"];
        const deliveryId = typeof idHeader === "string" ? idHeader : null;

        const signature = req.headers["x-hub-signature-256"];
        const verified = await verifyDelivery(
          rawBody,
          typeof signature === "string" ? signature : undefined
        );
        if (!verified) {
          await recordWebhookDelivery(
            {
              organizationId: null,
              deliveryId,
              event,
              verified: false,
              outcome: "rejected",
              detail: signature
                ? "X-Hub-Signature-256 did not match any connected App's webhook secret. If the App was recreated, reconnect it in Git settings."
                : "The delivery had no X-Hub-Signature-256 header."
            },
            req.log
          );
          // Deliberately vague: a caller probing for valid secrets learns
          // nothing beyond "rejected".
          return reply.code(401).send({ message: "Invalid signature" });
        }

        const ignore = async (detail: string) => {
          await recordWebhookDelivery(
            {
              organizationId: verified.organizationId,
              deliveryId,
              event,
              verified: true,
              outcome: "ignored",
              detail
            },
            req.log
          );
        };

        if (event === "ping") {
          await ignore("Ping from GitHub; the webhook URL and secret are correct.");
          return { ok: true };
        }

        if (event === "installation") {
          const action = (verified.payload as { action?: unknown } | null)
            ?.action;
          if (action === "deleted" || action === "suspend") {
            await prisma.gitHubApp.updateMany({
              where: { organizationId: verified.organizationId },
              data: { installationId: null, installedAt: null }
            });
            clearInstallationTokenCache(verified.appId);
            req.log.info(
              { action },
              "GitHub App installation removed; cleared installation id"
            );
          }
          await ignore(
            `Installation event (${typeof action === "string" ? action : "unknown"}).`
          );
          return { ok: true };
        }

        if (event !== "push") {
          await ignore(`Sohwe does not act on "${event || "unknown"}" events.`);
          return { ok: true, ignored: event };
        }

        const push = parsePushEvent(verified.payload);
        if (!push) {
          await ignore("The push payload was not in a shape Sohwe understands.");
          return { ok: true, ignored: "unsupported push payload" };
        }
        if (push.deleted) {
          await ignore(`Branch ${push.branch} was deleted; nothing to deploy.`);
          return { ok: true, ignored: "branch deleted" };
        }

        let deploymentIds: string[];
        try {
          deploymentIds = await enqueuePushDeploys(
            verified.organizationId,
            push
          );
        } catch (err) {
          await recordWebhookDelivery(
            {
              organizationId: verified.organizationId,
              deliveryId,
              event,
              verified: true,
              outcome: "error",
              detail:
                err instanceof Error
                  ? `Could not enqueue a deploy: ${err.message}`
                  : "Could not enqueue a deploy.",
              repoFullName: push.repoFullName,
              branch: push.branch,
              commitSha: push.headSha || null
            },
            req.log
          );
          throw err;
        }

        await recordWebhookDelivery(
          {
            organizationId: verified.organizationId,
            deliveryId,
            event,
            verified: true,
            outcome: deploymentIds.length > 0 ? "accepted" : "ignored",
            detail:
              deploymentIds.length > 0
                ? `Queued ${String(deploymentIds.length)} deploy${deploymentIds.length === 1 ? "" : "s"}.`
                : await explainNoDeploys(verified.organizationId, push),
            repoFullName: push.repoFullName,
            branch: push.branch,
            commitSha: push.headSha || null,
            deployCount: deploymentIds.length
          },
          req.log
        );

        req.log.info(
          {
            repo: push.repoFullName,
            branch: push.branch,
            deployments: deploymentIds.length
          },
          "Handled GitHub push"
        );

        return reply
          .code(deploymentIds.length > 0 ? 202 : 200)
          .send({ ok: true, deployments: deploymentIds.length });
      }
    );
  });
}
