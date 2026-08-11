import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appLogChannelName,
  appStatsKey,
  BACKUP_EXPORT_JOB,
  BACKUP_QUEUE,
  BACKUP_TICK_JOB,
  BACKUP_TICK_SCHEDULER_ID,
  DEPLOY_QUEUE,
  getConnectionOptionsForBull,
  getRedisUrl,
  logChannelName
} from "./index";

/**
 * These names are a wire contract: the worker publishes on them and the API
 * subscribes, in separate processes that only agree because both call these
 * helpers. A silent rename on one side produces a log stream that connects
 * fine and never delivers anything, so the exact strings are pinned.
 */

describe("channel and key names", () => {
  const id = "11111111-2222-3333-4444-555555555555";

  it("matches the documented build log channel", () => {
    assert.equal(logChannelName(id), `logs:deployment:${id}`);
  });

  it("matches the documented runtime log channel", () => {
    assert.equal(appLogChannelName(id), `logs:app:${id}`);
  });

  it("matches the documented stats key", () => {
    assert.equal(appStatsKey(id), `stats:app:${id}`);
  });

  it("keeps build and runtime logs in separate namespaces", () => {
    // A deployment id and an application id are both uuids; if these two
    // helpers ever produced the same string, build output would leak into the
    // runtime log stream.
    assert.notEqual(logChannelName(id), appLogChannelName(id));
  });

  it("is injective in its argument", () => {
    const other = "99999999-2222-3333-4444-555555555555";
    assert.notEqual(logChannelName(id), logChannelName(other));
    assert.notEqual(appLogChannelName(id), appLogChannelName(other));
    assert.notEqual(appStatsKey(id), appStatsKey(other));
  });
});

describe("queue and job names", () => {
  it("pins the queue names", () => {
    // Renaming a queue orphans everything already enqueued in Redis.
    assert.equal(DEPLOY_QUEUE, "deploy");
    assert.equal(BACKUP_QUEUE, "backup");
  });

  it("pins the backup job names", () => {
    assert.equal(BACKUP_TICK_JOB, "backup-tick");
    assert.equal(BACKUP_EXPORT_JOB, "backup-export");
  });

  it("keeps the tick scheduler id fixed so the tick stays singular", () => {
    assert.equal(BACKUP_TICK_SCHEDULER_ID, "backup-tick");
  });

  it("does not reuse one name for both queues", () => {
    assert.notEqual(DEPLOY_QUEUE, BACKUP_QUEUE);
  });
});

describe("getRedisUrl", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.REDIS_URL;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved;
  });

  it("returns the configured url", () => {
    process.env.REDIS_URL = "redis://example:6379";
    assert.equal(getRedisUrl(), "redis://example:6379");
  });

  it("throws rather than defaulting to localhost", () => {
    // A silent localhost default would let a misconfigured production worker
    // start and then never receive a job.
    delete process.env.REDIS_URL;
    assert.throws(getRedisUrl, /REDIS_URL is not set/);
  });

  it("feeds the BullMQ connection options", () => {
    process.env.REDIS_URL = "redis://example:6379";
    assert.deepEqual(getConnectionOptionsForBull(), { url: "redis://example:6379" });
  });
});
