import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApplicationLogRangeQuerySchema } from "@sohwe/types";
import { filterTimestampedRuntimeLogs } from "./runtime-log-history";

describe("runtime log date range", () => {
  const rows = [
    "2026-10-03T09:00:00.000000000Z before",
    "2026-10-03T10:00:00.000000000Z at start",
    "2026-10-03T10:30:00.000000000Z during",
    "2026-10-03T11:00:00.000000000Z at end",
    "2026-10-03T11:00:01.000000000Z after"
  ].join("\n");

  it("keeps both boundaries and excludes timestamps outside the range", () => {
    const result = filterTimestampedRuntimeLogs(
      rows,
      new Date("2026-10-03T10:00:00Z"),
      new Date("2026-10-03T11:00:00Z")
    );
    assert.equal(result.count, 3);
    assert.equal(result.truncated, false);
    assert.match(result.text, /at start/);
    assert.match(result.text, /during/);
    assert.match(result.text, /at end/);
    assert.doesNotMatch(result.text, /before|after/);
  });

  it("returns the newest bounded rows and reports truncation", () => {
    const result = filterTimestampedRuntimeLogs(
      rows,
      new Date("2026-10-03T09:00:00Z"),
      new Date("2026-10-03T12:00:00Z"),
      2
    );
    assert.equal(result.count, 2);
    assert.equal(result.truncated, true);
    assert.match(result.text, /at end/);
    assert.match(result.text, /after/);
    assert.doesNotMatch(result.text, /during/);
  });

  it("rejects an end time before the start time", () => {
    assert.equal(ApplicationLogRangeQuerySchema.safeParse({
      from: "2026-10-03T11:00:00Z",
      to: "2026-10-03T10:00:00Z"
    }).success, false);
  });
});
