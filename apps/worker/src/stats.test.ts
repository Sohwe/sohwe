import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appStatsKey } from "@sohwe/queue";
import {
  computeStats,
  createStatsSampler,
  STATS_TTL_SECONDS,
  type RawDockerStats,
  type StatsDocker
} from "./stats";

describe("computeStats", () => {
  it("applies the standard docker CPU% delta formula", () => {
    const raw: RawDockerStats = {
      cpu_stats: {
        cpu_usage: { total_usage: 400 },
        system_cpu_usage: 2000,
        online_cpus: 2
      },
      precpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 100, limit: 400 }
    };
    // (200 / 1000) * 2 cpus * 100 = 40%
    assert.equal(computeStats(raw).cpuPercent, 40);
  });

  it("reports zero CPU when there is no positive delta", () => {
    assert.equal(computeStats({}).cpuPercent, 0);
    const noSystemDelta: RawDockerStats = {
      cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 1000 },
      precpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000 }
    };
    assert.equal(computeStats(noSystemDelta).cpuPercent, 0);
  });

  it("subtracts page cache from memory usage like `docker stats`", () => {
    const v1: RawDockerStats = {
      memory_stats: { usage: 1000, limit: 2000, stats: { cache: 400 } }
    };
    const v2: RawDockerStats = {
      memory_stats: { usage: 1000, limit: 2000, stats: { inactive_file: 250 } }
    };
    assert.equal(computeStats(v1).memUsedBytes, 600);
    assert.equal(computeStats(v1).memPercent, 30);
    assert.equal(computeStats(v2).memUsedBytes, 750);
  });

  it("never reports negative memory and handles a missing limit", () => {
    const cacheAboveUsage: RawDockerStats = {
      memory_stats: { usage: 100, stats: { cache: 400 } }
    };
    const s = computeStats(cacheAboveUsage);
    assert.equal(s.memUsedBytes, 0);
    assert.equal(s.memLimitBytes, 0);
    assert.equal(s.memPercent, 0);
  });
});

describe("createStatsSampler", () => {
  const RAW: RawDockerStats = {
    cpu_stats: {
      cpu_usage: { total_usage: 400 },
      system_cpu_usage: 2000,
      online_cpus: 1
    },
    precpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000 },
    memory_stats: { usage: 512, limit: 1024 }
  };

  function makeDocker(
    containers: { Id: string; Labels?: Record<string, string> }[],
    statsById: Record<string, () => Promise<unknown>>
  ): { docker: StatsDocker; listedFilters: unknown[] } {
    const listedFilters: unknown[] = [];
    return {
      listedFilters,
      docker: {
        async listContainers(opts) {
          listedFilters.push(opts.filters);
          return containers;
        },
        getContainer(id) {
          return {
            stats: statsById[id] ?? (() => Promise.reject(new Error("no such")))
          };
        }
      }
    };
  }

  it("writes one snapshot per labeled running container", async () => {
    const { docker, listedFilters } = makeDocker(
      [
        { Id: "c1", Labels: { "sohwe.managed": "true", "sohwe.app": "app-1" } },
        // A datastore: managed but no sohwe.app label — must be skipped.
        { Id: "c2", Labels: { "sohwe.managed": "true" } }
      ],
      { c1: () => Promise.resolve(RAW) }
    );
    const writes: { key: string; json: string; ttl: number }[] = [];
    const sampler = createStatsSampler({
      docker,
      setStat: async (key, json, ttl) => {
        writes.push({ key, json, ttl });
      },
      now: () => 1_000_000
    });

    await sampler.sampleOnce();

    assert.deepEqual(listedFilters, [
      { label: ["sohwe.managed=true"], status: ["running"] }
    ]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.key, appStatsKey("app-1"));
    assert.equal(writes[0]?.ttl, STATS_TTL_SECONDS);
    assert.deepEqual(JSON.parse(writes[0]?.json ?? ""), {
      running: true,
      cpuPercent: 20,
      memUsedBytes: 512,
      memLimitBytes: 1024,
      memPercent: 50,
      ts: 1_000_000
    });
  });

  it("skips a container whose stats call fails without failing the sweep", async () => {
    const { docker } = makeDocker(
      [
        { Id: "gone", Labels: { "sohwe.app": "app-gone" } },
        { Id: "ok", Labels: { "sohwe.app": "app-ok" } }
      ],
      {
        gone: () => Promise.reject(new Error("container stopped")),
        ok: () => Promise.resolve(RAW)
      }
    );
    const keys: string[] = [];
    const sampler = createStatsSampler({
      docker,
      setStat: async (key) => {
        keys.push(key);
      }
    });

    await sampler.sampleOnce();
    assert.deepEqual(keys, [appStatsKey("app-ok")]);
  });

  it("start and stop are idempotent", () => {
    const { docker } = makeDocker([], {});
    const sampler = createStatsSampler({ docker, setStat: async () => {} });
    sampler.stop(); // before start: no-op
    sampler.start();
    sampler.start(); // second start must not double the timer
    sampler.stop();
    sampler.stop();
  });
});
