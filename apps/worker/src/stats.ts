import { appStatsKey } from "@sohwe/queue";

// Live CPU/memory stats (Phase 4), extracted from the worker entrypoint so the
// sampling loop is testable against a Docker double.
//
// Every few seconds we sample one-shot Docker stats for each managed running
// container and write a compact JSON snapshot to Redis under `stats:app:<id>`
// with a short TTL. The API reads this key (polling); when it expires the app
// is reported as not running. We deliberately avoid streaming stats — periodic
// one-shot reads are simpler and the daemon still populates `precpu_stats` so
// the standard CPU% delta formula works.

export const STATS_INTERVAL_MS = 3000;
export const STATS_TTL_SECONDS = 10;

export type RawDockerStats = {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { cache?: number; inactive_file?: number };
  };
};

export function computeStats(raw: RawDockerStats): {
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  memPercent: number;
} {
  const cpuTotal = raw.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const preTotal = raw.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const system = raw.cpu_stats?.system_cpu_usage ?? 0;
  const preSystem = raw.precpu_stats?.system_cpu_usage ?? 0;
  const onlineCpus = raw.cpu_stats?.online_cpus ?? 1;
  const cpuDelta = cpuTotal - preTotal;
  const systemDelta = system - preSystem;
  const cpuPercent =
    systemDelta > 0 && cpuDelta > 0
      ? (cpuDelta / systemDelta) * onlineCpus * 100
      : 0;

  const rawUsage = raw.memory_stats?.usage ?? 0;
  // Match `docker stats`: subtract page cache (cgroup v1 `cache`, v2 `inactive_file`).
  const cache =
    raw.memory_stats?.stats?.cache ??
    raw.memory_stats?.stats?.inactive_file ??
    0;
  const memUsedBytes = Math.max(0, rawUsage - cache);
  const memLimitBytes = raw.memory_stats?.limit ?? 0;
  const memPercent =
    memLimitBytes > 0 ? (memUsedBytes / memLimitBytes) * 100 : 0;

  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memUsedBytes,
    memLimitBytes,
    memPercent: Math.round(memPercent * 10) / 10
  };
}

/** The slice of dockerode the sampler touches; a test double implements this. */
export type StatsDocker = {
  listContainers(opts: {
    filters: { label: string[]; status: string[] };
  }): Promise<{ Id: string; Labels?: Record<string, string> }[]>;
  getContainer(id: string): {
    stats(opts: { stream: false }): Promise<unknown>;
  };
};

export function createStatsSampler(deps: {
  docker: StatsDocker;
  /** Write one snapshot; the caller binds this to Redis `SET ... EX ttl`. */
  setStat: (key: string, json: string, ttlSeconds: number) => Promise<unknown>;
  intervalMs?: number;
  ttlSeconds?: number;
  now?: () => number;
}): {
  sampleOnce(): Promise<void>;
  start(): void;
  stop(): void;
} {
  const intervalMs = deps.intervalMs ?? STATS_INTERVAL_MS;
  const ttlSeconds = deps.ttlSeconds ?? STATS_TTL_SECONDS;
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function sampleOnce(): Promise<void> {
    const containers = await deps.docker.listContainers({
      filters: { label: ["sohwe.managed=true"], status: ["running"] }
    });
    await Promise.all(
      containers.map(async (c) => {
        // Datastores are sohwe.managed but carry no sohwe.app label, which is
        // exactly what keeps them out of the per-app stats surface.
        const appId = c.Labels?.["sohwe.app"];
        if (!appId) return;
        try {
          const raw = (await deps.docker
            .getContainer(c.Id)
            .stats({ stream: false })) as RawDockerStats;
          const s = computeStats(raw);
          await deps.setStat(
            appStatsKey(appId),
            JSON.stringify({ running: true, ...s, ts: now() }),
            ttlSeconds
          );
        } catch {
          // Container may have stopped between listing and sampling; skip.
        }
      })
    );
  }

  return {
    sampleOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void sampleOnce().catch(() => {});
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}
