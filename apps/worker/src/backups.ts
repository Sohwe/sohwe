import parser from "cron-parser";
import { runScheduledExport } from "@sohwe/backups";
import { prisma } from "@sohwe/db";
import {
  BACKUP_EXPORT_JOB,
  BACKUP_QUEUE,
  BACKUP_TICK_JOB,
  BACKUP_TICK_SCHEDULER_ID,
  createBackupQueue,
  getConnectionOptionsForBull,
  Queue,
  Worker,
  type BackupExportJobData,
  type BackupJobData
} from "@sohwe/queue";

const SOHWE_VERSION = process.env.SOHWE_VERSION ?? "0.5.0";
/** How often the tick scans for due schedules. */
const TICK_MS = 60_000;

/**
 * A schedule is due when its next cron occurrence after the last run (or its
 * creation, if it has never run) is now in the past. Invalid cron never fires
 * — the API validates on write, but the worker stays defensive.
 */
function isDue(cron: string, base: Date, now: Date): boolean {
  try {
    const it = parser.parseExpression(cron, { currentDate: base });
    return it.next().toDate().getTime() <= now.getTime();
  } catch {
    return false;
  }
}

/**
 * Scan enabled schedules and enqueue an export for each that is due. We advance
 * `lastRunAt` before enqueuing so a slow export can't be enqueued twice by the
 * next tick.
 */
async function runTick(queue: Queue<BackupJobData>): Promise<void> {
  const now = new Date();
  const schedules = await prisma.backupSchedule.findMany({
    where: { enabled: true }
  });
  for (const s of schedules) {
    const base = s.lastRunAt ?? s.createdAt;
    if (!isDue(s.cron, base, now)) continue;
    await prisma.backupSchedule.update({
      where: { id: s.id },
      data: { lastRunAt: now }
    });
    await queue.add(BACKUP_EXPORT_JOB, {
      scheduleId: s.id
    } satisfies BackupExportJobData);
  }
}

export type BackupSubsystem = {
  queue: Queue<BackupJobData>;
  worker: Worker<BackupJobData>;
  close: () => Promise<void>;
};

/**
 * Start the backup queue worker and register the repeatable tick. The tick
 * drives scheduled exports; export jobs build + write the bundle and apply
 * retention via the shared `@sohwe/backups` orchestration.
 */
export async function startBackupSubsystem(): Promise<BackupSubsystem> {
  const connection = getConnectionOptionsForBull();
  const queue = createBackupQueue();

  const worker = new Worker<BackupJobData>(
    BACKUP_QUEUE,
    async (job) => {
      if (job.name === BACKUP_EXPORT_JOB) {
        const { scheduleId } = job.data as BackupExportJobData;
        const res = await runScheduledExport(scheduleId, SOHWE_VERSION);
        console.log(
          `Scheduled export ${res.status}: schedule=${scheduleId} file=${res.filename} apps=${res.appCount} pruned=${res.retentionRemoved}`
        );
        return;
      }
      // Default: the repeatable tick.
      await runTick(queue);
    },
    { connection }
  );

  worker.on("failed", (job, err) => {
    console.error("Backup job failed", job?.id, job?.name, err);
  });
  worker.on("error", (err) => {
    console.error("Backup worker error", err);
  });

  // Idempotent: re-registering keeps a single repeatable tick.
  await queue.upsertJobScheduler(
    BACKUP_TICK_SCHEDULER_ID,
    { every: TICK_MS },
    { name: BACKUP_TICK_JOB, data: {} }
  );

  return {
    queue,
    worker,
    close: async () => {
      await worker.close();
      await queue.close();
    }
  };
}
