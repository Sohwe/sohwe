import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  buildAlertPayload,
  classifyCrashEvent,
  createDockerEventWatcher,
  type CrashInfo,
  type DockerEvent
} from "./crash-watch";

function dieEvent(overrides: Partial<DockerEvent> = {}): DockerEvent {
  return {
    Type: "container",
    Action: "die",
    Actor: {
      ID: "abc123def456abc123def456",
      Attributes: { "sohwe.app": "app-1", exitCode: "1" }
    },
    ...overrides
  };
}

describe("classifyCrashEvent", () => {
  it("treats a nonzero die as a crash", () => {
    assert.deepEqual(classifyCrashEvent(dieEvent()), {
      appId: "app-1",
      event: "crashed",
      exitCode: "1",
      containerId: "abc123def456abc123def456"
    } satisfies CrashInfo);
  });

  it("ignores a clean stop and a die with no exit code", () => {
    for (const exitCode of ["0", ""] as const) {
      const ev = dieEvent();
      ev.Actor!.Attributes!.exitCode = exitCode;
      assert.equal(classifyCrashEvent(ev), null);
    }
  });

  it("always treats an OOM kill as a crash, even without an exit code", () => {
    const ev = dieEvent({ Action: "oom" });
    delete ev.Actor!.Attributes!.exitCode;
    assert.deepEqual(classifyCrashEvent(ev), {
      appId: "app-1",
      event: "out of memory",
      exitCode: "",
      containerId: "abc123def456abc123def456"
    });
  });

  it("ignores events without the sohwe.app label (e.g. datastores)", () => {
    const ev = dieEvent();
    delete ev.Actor!.Attributes!["sohwe.app"];
    assert.equal(classifyCrashEvent(ev), null);
  });

  it("ignores non-container types and unrelated actions", () => {
    assert.equal(classifyCrashEvent(dieEvent({ Type: "network" })), null);
    assert.equal(classifyCrashEvent(dieEvent({ Action: "start" })), null);
  });

  it("accepts the legacy `status` field and falls back to `id`", () => {
    const ev = dieEvent({ Action: undefined, status: "die" });
    delete ev.Actor!.ID;
    ev.id = "fallback-id";
    assert.equal(classifyCrashEvent(ev)?.containerId, "fallback-id");
  });
});

describe("buildAlertPayload", () => {
  const info = {
    appName: "Web",
    appSlug: "web",
    event: "crashed",
    exitCode: "137",
    containerId: "abc123def456abc123def456",
    timeIso: "2026-08-13T00:00:00.000Z"
  };

  it("shapes slack, discord, and generic payloads", () => {
    const slack = buildAlertPayload("slack", info) as { text: string };
    assert.ok(slack.text.includes('app "Web" crashed'));
    // Container ids are truncated to 12 chars, like docker ps.
    assert.ok(slack.text.includes("Container: abc123def456\n"));

    const discord = buildAlertPayload("discord", info) as { content: string };
    assert.ok(discord.content.startsWith("**"));

    assert.deepEqual(buildAlertPayload("generic", info), {
      type: "sohwe.crash",
      app: { name: "Web", slug: "web" },
      event: "crashed",
      exitCode: "137",
      containerId: "abc123def456abc123def456",
      time: "2026-08-13T00:00:00.000Z"
    });
  });
});

describe("createDockerEventWatcher", () => {
  function makeWatcher(opts: { reconnectDelayMs?: number } = {}) {
    const streams: PassThrough[] = [];
    const crashes: CrashInfo[] = [];
    const watcher = createDockerEventWatcher({
      docker: {
        getEvents: async () => {
          const s = new PassThrough();
          streams.push(s);
          return s;
        }
      },
      onCrash: async (c) => {
        crashes.push(c);
      },
      onError: () => {},
      reconnectDelayMs: opts.reconnectDelayMs ?? 5
    });
    return { watcher, streams, crashes };
  }

  const tick = () => new Promise((r) => setImmediate(r));

  it("classifies newline-delimited events, buffering partial lines", async () => {
    const { watcher, streams, crashes } = makeWatcher();
    await watcher.start();
    const stream = streams[0]!;

    const line = JSON.stringify(dieEvent());
    // Split mid-JSON across two chunks to prove the line buffer works.
    stream.write(line.slice(0, 10));
    stream.write(`${line.slice(10)}\nnot json\n`);
    // A clean stop on the same stream must not produce a second crash.
    const clean = dieEvent();
    clean.Actor!.Attributes!.exitCode = "0";
    stream.write(`${JSON.stringify(clean)}\n`);
    await tick();

    assert.equal(crashes.length, 1);
    assert.equal(crashes[0]?.appId, "app-1");
    watcher.stop();
  });

  it("resubscribes when the stream ends, but not after stop()", async () => {
    const { watcher, streams } = makeWatcher({ reconnectDelayMs: 5 });
    await watcher.start();
    assert.equal(streams.length, 1);

    streams[0]!.end();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(streams.length, 2, "expected a reconnect after end");

    watcher.stop();
    streams[1]!.emit("close");
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(streams.length, 2, "no reconnect after stop()");
  });

  it("survives a failed subscription", async () => {
    const errors: string[] = [];
    const watcher = createDockerEventWatcher({
      docker: {
        getEvents: async () => {
          throw new Error("daemon down");
        }
      },
      onCrash: async () => {},
      onError: (msg) => {
        errors.push(msg);
      }
    });
    await watcher.start();
    assert.deepEqual(errors, ["Failed to subscribe to Docker events"]);
    watcher.stop();
  });
});
