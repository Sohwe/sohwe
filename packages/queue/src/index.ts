import IORedis, { type Redis } from "ioredis";
import { Queue, type ConnectionOptions } from "bullmq";

export const DEPLOY_QUEUE = "deploy";

export type DeployJobData = {
  deploymentId: string;
  applicationId: string;
  /** When set, skip build and use this image tag from the source deployment. */
  promoteImageFromDeploymentId?: string;
};

// --- Backups (Phase 4.5): scheduled exports + retention --------------------

export const BACKUP_QUEUE = "backup";

/** Repeatable tick that scans for due schedules; fixed id keeps it singular. */
export const BACKUP_TICK_JOB = "backup-tick";
export const BACKUP_TICK_SCHEDULER_ID = "backup-tick";
/** A single due schedule, enqueued by the tick for the export worker to run. */
export const BACKUP_EXPORT_JOB = "backup-export";

export type BackupTickJobData = Record<string, never>;
export type BackupExportJobData = { scheduleId: string };
export type BackupJobData = BackupTickJobData | BackupExportJobData;

// --- Datastores (Phase 7): provision / delete / rotate ----------------------

export const DATASTORE_QUEUE = "datastore";

export const DATASTORE_PROVISION_JOB = "datastore-provision";
export const DATASTORE_DELETE_JOB = "datastore-delete";
export const DATASTORE_ROTATE_JOB = "datastore-rotate";

export type DatastoreProvisionJobData = { datastoreId: string };
export type DatastoreDeleteJobData = { datastoreId: string };
export type DatastoreRotateJobData = { datastoreId: string };
export type DatastoreJobData =
  | DatastoreProvisionJobData
  | DatastoreDeleteJobData
  | DatastoreRotateJobData;

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

export function createBackupQueue(): Queue<BackupJobData> {
  return new Queue<BackupJobData>(BACKUP_QUEUE, {
    connection: getConnectionOptionsForBull(),
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 100 }
  });
}

export function createDatastoreQueue(): Queue<DatastoreJobData> {
  return new Queue<DatastoreJobData>(DATASTORE_QUEUE, {
    connection: getConnectionOptionsForBull(),
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 100 }
  });
}

export function createRedisForPublish(): Redis {
  return new IORedis(getRedisUrl());
}

export { Job, Queue, Worker } from "bullmq";
