import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeProjectLogs, type ProjectLog } from "./project-logs.ts";
const log = (id: string, message = id) => ({ id, message }) as ProjectLog;
test("replayed service output and older pages retain bigint cursor order without duplicates", () => {
  assert.deepEqual(
    mergeProjectLogs(
      [log("9007199254740993"), log("9007199254740995")],
      [log("9007199254740994"), log("9007199254740993")],
      5,
    ).map((row) => row.id),
    ["9007199254740993", "9007199254740994", "9007199254740995"],
  );
});
test("live buffers stay bounded and reject invalid cursors", () => {
  assert.deepEqual(
    mergeProjectLogs([log("1"), log("2")], [log("3"), log("bad")], 2).map(
      (row) => row.id,
    ),
    ["2", "3"],
  );
});
