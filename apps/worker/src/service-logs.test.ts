import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  boundLogMessage,
  inferLogLevel,
  MAX_SERVICE_LOG_LINE_BYTES,
  parseTimestampedLogLine
} from "./service-logs";

describe("service log events", () => {
  it("preserves Docker's container timestamp separately from the message", () => {
    const parsed = parseTimestampedLogLine(
      "2026-09-11T12:34:56.123456789Z worker started"
    );
    assert.equal(parsed.message, "worker started");
    assert.equal(parsed.containerTimestamp?.toISOString(), "2026-09-11T12:34:56.123Z");
    assert.equal(parsed.containerTimestampRaw, "2026-09-11T12:34:56.123456789Z");
  });

  it("keeps application text unchanged when Docker supplied no timestamp", () => {
    assert.deepEqual(parseTimestampedLogLine("Error: queue failed"), {
      message: "Error: queue failed",
      containerTimestamp: null,
      containerTimestampRaw: null
    });
  });

  it("bounds individual events", () => {
    const value = boundLogMessage("x".repeat(MAX_SERVICE_LOG_LINE_BYTES + 100));
    assert.ok(Buffer.byteLength(value) <= MAX_SERVICE_LOG_LINE_BYTES);
    assert.match(value, /truncated by Sohwe/);
  });

  it("derives a filterable severity without rewriting the message", () => {
    assert.equal(inferLogLevel("ERROR database unavailable"), "error");
    assert.equal(inferLogLevel("warning: retrying"), "warn");
    assert.equal(inferLogLevel("request complete"), "info");
  });
});
