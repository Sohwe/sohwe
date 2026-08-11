import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_LOG_HEAD_BYTES,
  BUILD_LOG_MAX_BYTES,
  BUILD_LOG_TAIL_BYTES,
  BUILD_LOG_TAIL_FLUSH_MS,
  BUILD_LOG_TRUNCATION_NOTICE,
  LogSink,
  takeHeadBytes,
  takeTailBytes,
  type BuildLogStore
} from "./build-log";

/** Records what the sink asked storage to do, and simulates the stored value. */
function fakeStore() {
  const calls: { op: "append" | "replace"; bytes: number }[] = [];
  let value = "";
  const store: BuildLogStore = {
    append: (text) => {
      calls.push({ op: "append", bytes: Buffer.byteLength(text, "utf8") });
      value += text;
      return Promise.resolve();
    },
    replace: (text) => {
      calls.push({ op: "replace", bytes: Buffer.byteLength(text, "utf8") });
      value = text;
      return Promise.resolve();
    }
  };
  return {
    store,
    calls,
    get value() {
      return value;
    },
    /** Total bytes handed to storage — the cost the O(n^2) shape used to blow up. */
    get written() {
      return calls.reduce((n, c) => n + c.bytes, 0);
    }
  };
}

function lines(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${String(i)}`);
}

describe("takeHeadBytes", () => {
  it("returns the whole string when it fits", () => {
    assert.equal(takeHeadBytes("abc\n", 100), "abc\n");
  });

  it("cuts back to the last newline", () => {
    assert.equal(takeHeadBytes("aaa\nbbb\nccc\n", 9), "aaa\nbbb\n");
  });

  it("returns a prefix of the input", () => {
    const text = "one\ntwo\nthree\n";
    const head = takeHeadBytes(text, 6);
    assert.ok(text.startsWith(head), `${JSON.stringify(head)} is not a prefix`);
  });

  it("never emits a replacement character from a split multi-byte char", () => {
    // "é" is two bytes; cutting at 1 byte would split it.
    assert.equal(takeHeadBytes("é", 1), "");
  });

  it("returns nothing for a non-positive budget", () => {
    assert.equal(takeHeadBytes("abc", 0), "");
    assert.equal(takeHeadBytes("abc", -5), "");
  });
});

describe("takeTailBytes", () => {
  it("returns the whole string when it fits", () => {
    assert.equal(takeTailBytes("abc\n", 100), "abc\n");
  });

  it("drops leading partial lines", () => {
    assert.equal(takeTailBytes("aaa\nbbb\nccc\n", 9), "bbb\nccc\n");
  });

  it("stays within the byte budget", () => {
    const text = lines(500, "x").join("\n");
    const tail = takeTailBytes(text, 200);
    assert.ok(Buffer.byteLength(tail, "utf8") <= 200);
    assert.ok(text.endsWith(tail));
  });
});

describe("LogSink", () => {
  it("appends once with everything buffered", async () => {
    const f = fakeStore();
    const sink = new LogSink(f.store);
    sink.line("first");
    sink.line("second");
    await sink.end();

    assert.deepEqual(
      f.calls.map((c) => c.op),
      ["append"]
    );
    assert.equal(f.value, "first\nsecond\n");
  });

  it("adds the missing newline exactly once", async () => {
    const f = fakeStore();
    const sink = new LogSink(f.store);
    sink.line("has one\n");
    sink.line("has none");
    await sink.end();
    assert.equal(f.value, "has one\nhas none\n");
  });

  it("writes nothing when no lines were emitted", async () => {
    const f = fakeStore();
    const sink = new LogSink(f.store);
    await sink.end();
    assert.deepEqual(f.calls, []);
  });

  it("ignores lines after end()", async () => {
    const f = fakeStore();
    const sink = new LogSink(f.store);
    sink.line("kept");
    await sink.end();
    sink.line("dropped");
    assert.equal(f.value, "kept\n");
  });

  it("never appends after truncating, so writes stay bounded", async () => {
    const f = fakeStore();
    const sink = new LogSink(f.store);
    // Roughly 3x the cap, in chunks, so the head fills and the tail rolls.
    const chunk = "y".repeat(1000);
    for (let i = 0; i < (BUILD_LOG_MAX_BYTES * 3) / 1000; i++) {
      sink.line(chunk);
    }
    await sink.end();

    assert.ok(sink.isTruncated, "expected the sink to report truncation");
    // Only one flush happened (a single end()), so a single bounded write.
    assert.deepEqual(
      f.calls.map((c) => c.op),
      ["replace"]
    );
    assert.ok(
      f.written <= BUILD_LOG_MAX_BYTES + BUILD_LOG_TRUNCATION_NOTICE.length,
      `wrote ${String(f.written)} bytes`
    );
  });

  it("keeps the stored value within the cap plus the notice", async () => {
    const f = fakeStore();
    const sink = new LogSink(f.store);
    for (const l of lines(200_000, "some build output line")) sink.line(l);
    await sink.end();

    const stored = Buffer.byteLength(f.value, "utf8");
    assert.ok(sink.isTruncated);
    assert.ok(
      stored <= BUILD_LOG_MAX_BYTES + Buffer.byteLength(BUILD_LOG_TRUNCATION_NOTICE, "utf8"),
      `stored ${String(stored)} bytes`
    );
    assert.ok(
      stored > BUILD_LOG_HEAD_BYTES,
      "expected both a head and a tail to be kept"
    );
  });

  it("keeps the start of the build, the end of the build, and a notice between", async () => {
    const f = fakeStore();
    const sink = new LogSink(f.store);
    sink.line("FIRST-LINE-MARKER");
    for (const l of lines(60_000, "filler filler filler filler")) sink.line(l);
    sink.line("LAST-LINE-MARKER");
    await sink.end();

    const noticeAt = f.value.indexOf(BUILD_LOG_TRUNCATION_NOTICE);
    assert.ok(noticeAt > 0, "expected a truncation notice");
    assert.ok(f.value.startsWith("FIRST-LINE-MARKER\n"));
    assert.ok(f.value.trimEnd().endsWith("LAST-LINE-MARKER"));
    // The dropped middle is what makes this a truncation rather than a cap.
    assert.ok(!f.value.includes("filler filler filler filler 30000"));
  });

  it("does not grow the head past its budget", async () => {
    const f = fakeStore();
    const sink = new LogSink(f.store);
    for (const l of lines(100_000, "line")) sink.line(l);
    await sink.end();

    const head = f.value.slice(0, f.value.indexOf(BUILD_LOG_TRUNCATION_NOTICE));
    assert.ok(Buffer.byteLength(head, "utf8") <= BUILD_LOG_HEAD_BYTES);
  });

  it("does not grow the tail past its budget", async () => {
    const f = fakeStore();
    const sink = new LogSink(f.store);
    for (const l of lines(100_000, "line")) sink.line(l);
    await sink.end();

    const at = f.value.indexOf(BUILD_LOG_TRUNCATION_NOTICE);
    const tail = f.value.slice(at + BUILD_LOG_TRUNCATION_NOTICE.length);
    assert.ok(Buffer.byteLength(tail, "utf8") <= BUILD_LOG_TAIL_BYTES);
  });

  it("rate-limits rewrites once truncated", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let clock = 0;
    const f = fakeStore();
    const sink = new LogSink(f.store, () => clock);

    const settle = async () => {
      t.mock.timers.tick(200);
      // Let the flush promise resolve; setImmediate is not mocked.
      await new Promise((r) => setImmediate(r));
    };

    // Fill the head so every later flush takes the rewrite path.
    sink.line("z".repeat(BUILD_LOG_HEAD_BYTES + 10));
    await settle();
    const afterFirst = f.calls.length;

    // Three more flushes inside the rate-limit window write nothing.
    for (let i = 0; i < 3; i++) {
      sink.line("more output");
      clock += BUILD_LOG_TAIL_FLUSH_MS / 4;
      await settle();
    }
    assert.equal(f.calls.length, afterFirst, "expected rewrites to be suppressed");

    // Past the window, one rewrite lands.
    clock += BUILD_LOG_TAIL_FLUSH_MS;
    sink.line("later output");
    await settle();
    assert.equal(f.calls.length, afterFirst + 1);

    // end() always writes, regardless of the window.
    sink.line("final output");
    await sink.end();
    assert.ok(f.value.trimEnd().endsWith("final output"));
  });

  it("reports the most recent lines for failure diagnosis", async () => {
    const f = fakeStore();
    const sink = new LogSink(f.store);
    for (const l of lines(10, "step")) sink.line(l);
    assert.deepEqual(sink.recentLines(3), ["step 7", "step 8", "step 9"]);
    // Includes lines still buffered, since a failure can arrive mid-debounce.
    sink.line("boom");
    assert.deepEqual(sink.recentLines(2), ["step 9", "boom"]);
    await sink.end();
  });

  it("reports recent lines after truncation", async () => {
    const f = fakeStore();
    const sink = new LogSink(f.store);
    for (const l of lines(100_000, "noise")) sink.line(l);
    sink.line("the actual error");
    const recent = sink.recentLines(2);
    assert.equal(recent[recent.length - 1], "the actual error");
    await sink.end();
  });
});
