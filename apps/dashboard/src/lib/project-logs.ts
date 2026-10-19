export type ProjectLog = {
  id: string;
  serviceId: string;
  releaseId: string;
  stream: string;
  level: string;
  message: string;
  containerId: string | null;
  containerTimestamp: string | null;
  restartNumber: number;
  createdAt: string;
};

/** Persisted IDs are bigint cursors. Deduplicate replay/history overlaps without
 * losing order above Number.MAX_SAFE_INTEGER, and keep memory bounded. */
export function mergeProjectLogs(
  current: ProjectLog[],
  incoming: ProjectLog[],
  limit: number,
): ProjectLog[] {
  const byId = new Map(current.map((log) => [log.id, log]));
  for (const log of incoming) if (/^\d+$/.test(log.id)) byId.set(log.id, log);
  return [...byId.values()]
    .sort((a, b) =>
      BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
    )
    .slice(-limit);
}
