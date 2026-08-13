import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  createRuntimeLogTailManager,
  type LogTailContainer,
  type LogTailDocker
} from "./runtime-logs";

const tick = () => new Promise((r) => setImmediate(r));

function fakeContainer(id: string): {
  container: LogTailContainer;
  stream: PassThrough;
} {
  const stream = new PassThrough();
  return {
    stream,
    container: { id, logs: async () => stream }
  };
}

function makeManager(opts: {
  containers?: Record<string, LogTailContainer>;
  listed?: { Id: string; Labels?: Record<string, string> }[];
  demux?: Parameters<typeof createRuntimeLogTailManager>[0]["demux"];
}) {
  const published: { appId: string; line: string }[] = [];
  const docker: LogTailDocker = {
    listContainers: async () => opts.listed ?? [],
    getContainer: (id) => {
      const c = opts.containers?.[id];
      if (!c) throw new Error(`unexpected getContainer(${id})`);
      return c;
    }
  };
  const manager = createRuntimeLogTailManager({
    docker,
    publish: (appId, line) => published.push({ appId, line }),
    demux: opts.demux
  });
  return { manager, published };
}

describe("createRuntimeLogTailManager", () => {
  it("splits chunks into lines and buffers partials (raw fallback path)", async () => {
    const { container, stream } = fakeContainer("c1");
    const { manager, published } = makeManager({});
    await manager.start("app-1", container);

    stream.write("line1\nline2\npartial");
    await tick();
    assert.deepEqual(
      published.map((p) => p.line),
      ["line1", "line2"]
    );

    stream.write("-rest\r\n");
    await tick();
    assert.equal(published[2]?.line, "partial-rest");

    // A trailing unterminated line is flushed when the stream ends.
    stream.write("tail");
    stream.end();
    await tick();
    assert.equal(published[3]?.line, "tail");
    assert.equal(manager.size(), 0, "tail registration cleared on end");
  });

  it("demultiplexes through the provided demuxer when it works", async () => {
    const { container, stream } = fakeContainer("c1");
    const { manager, published } = makeManager({
      demux: (s, stdout) => {
        s.on("data", (b) => stdout.write(b));
      }
    });
    await manager.start("app-1", container);
    stream.write("demuxed\n");
    await tick();
    assert.deepEqual(published, [{ appId: "app-1", line: "demuxed" }]);
    manager.stopAll();
  });

  it("replaces an existing tail; the old stream's end must not clear the new one", async () => {
    const first = fakeContainer("c1");
    const second = fakeContainer("c2");
    const { manager } = makeManager({});

    await manager.start("app-1", first.container);
    let destroyed = false;
    first.stream.on("close", () => {
      destroyed = true;
    });

    await manager.start("app-1", second.container);
    await tick();
    assert.equal(destroyed, true, "old stream destroyed on replacement");
    assert.equal(manager.size(), 1, "replacement tail registered");

    // The destroyed old stream fires close/end after the replacement exists;
    // the containerId guard must keep the new registration.
    first.stream.emit("end");
    await tick();
    assert.equal(manager.size(), 1);
    manager.stopAll();
    assert.equal(manager.size(), 0);
  });

  it("publishes a marker line when attaching fails", async () => {
    const { manager, published } = makeManager({});
    await manager.start("app-1", {
      id: "c1",
      logs: async () => {
        throw new Error("boom");
      }
    });
    assert.deepEqual(published, [
      { appId: "app-1", line: "[sohwe] Failed to attach runtime logs: boom" }
    ]);
    assert.equal(manager.size(), 0);
  });

  it("publishes a marker line and cleans up when the stream errors", async () => {
    const { container, stream } = fakeContainer("c1");
    const { manager, published } = makeManager({});
    await manager.start("app-1", container);

    stream.emit("error", new Error("hangup"));
    await tick();
    assert.equal(
      published[0]?.line,
      "[sohwe] Runtime log stream ended: hangup"
    );
    assert.equal(manager.size(), 0);
  });

  it("re-attaches only labeled app containers on startup recovery", async () => {
    const appContainer = fakeContainer("running-app");
    const { manager } = makeManager({
      containers: { "running-app": appContainer.container },
      listed: [
        {
          Id: "running-app",
          Labels: { "sohwe.managed": "true", "sohwe.app": "app-1" }
        },
        // A datastore: managed, no sohwe.app label. getContainer would throw
        // for this id, so reaching for it fails the test.
        { Id: "datastore", Labels: { "sohwe.managed": "true" } }
      ]
    });

    await manager.startForRunning();
    assert.equal(manager.size(), 1);
    manager.stopAll();
  });
});
