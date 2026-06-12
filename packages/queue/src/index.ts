import IORedis, { type Redis } from "ioredis";
import { Queue, type ConnectionOptions } from "bullmq";

export const DEPLOY_QUEUE = "deploy";

export type DeployJobData = {
  deploymentId: string;
  applicationId: string;
  /** When set, skip build and use this image tag from the source deployment. */
  promoteImageFromDeploymentId?: string;
};

export function logChannelName(deploymentId: string): string {
  return `logs:deployment:${deploymentId}`;
}

export function appLogChannelName(applicationId: string): string {
  return `logs:app:${applicationId}`;
}

/**
 * Redis string key holding the latest CPU/memory sample for an app, written by
 * the worker with a short TTL and read by the API stats endpoint (polling).
 */
export function appStatsKey(applicationId: string): string {
  return `stats:app:${applicationId}`;
}

export function getRedisUrl(): string {
  const u = process.env.REDIS_URL;
  if (!u) throw new Error("REDIS_URL is not set");
  return u;
}

export function getConnectionOptionsForBull(): ConnectionOptions {
  return { url: getRedisUrl() };
}

export function createQueue(): Queue<DeployJobData> {
  return new Queue<DeployJobData>(DEPLOY_QUEUE, {
    connection: getConnectionOptionsForBull(),
    defaultJobOptions: { removeOnComplete: 200, removeOnFail: 100 }
  });
}

export function createRedisForPublish(): Redis {
  return new IORedis(getRedisUrl());
}

export { Job, Worker } from "bullmq";
