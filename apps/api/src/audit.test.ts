import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_ACTIONS, envChangeMetadata } from "./audit";

describe("envChangeMetadata", () => {
  it("classifies added, removed, and changed keys", () => {
    const meta = envChangeMetadata(
      { KEEP: "same", CHANGE: "before", DROP: "gone" },
      { KEEP: "same", CHANGE: "after", ADD: "new" }
    );
    assert.deepEqual(meta.added, ["ADD"]);
    assert.deepEqual(meta.removed, ["DROP"]);
    assert.deepEqual(meta.changed, ["CHANGE"]);
    assert.equal(meta.totalKeys, 3);
  });

  it("never includes a value, only key names and counts", () => {
    const meta = envChangeMetadata(
      { OLD_TOKEN: "old-secret-value" },
      { NEW_TOKEN: "new-secret-value", OLD_TOKEN: "rotated-secret-value" }
    );
    const serialized = JSON.stringify(meta);
    assert.ok(!serialized.includes("old-secret-value"));
    assert.ok(!serialized.includes("new-secret-value"));
    assert.ok(!serialized.includes("rotated-secret-value"));
    assert.ok(serialized.includes("NEW_TOKEN"));
  });

  it("sorts key lists so the same change reads the same way twice", () => {
    const meta = envChangeMetadata({}, { B: "1", A: "1", C: "1" });
    assert.deepEqual(meta.added, ["A", "B", "C"]);
  });

  it("reports an unchanged set as no change", () => {
    const meta = envChangeMetadata({ A: "1" }, { A: "1" });
    assert.equal(meta.addedCount, 0);
    assert.equal(meta.removedCount, 0);
    assert.equal(meta.changedCount, 0);
    assert.equal(meta.totalKeys, 1);
  });

  it("counts clearing every var as removals", () => {
    const meta = envChangeMetadata({ A: "1", B: "2" }, {});
    assert.deepEqual(meta.removed, ["A", "B"]);
    assert.equal(meta.totalKeys, 0);
  });
});

describe("audit action vocabulary", () => {
  it("has no duplicates", () => {
    assert.equal(new Set(AUDIT_ACTIONS).size, AUDIT_ACTIONS.length);
  });

  it("names every action as <target>.<verb>", () => {
    for (const action of AUDIT_ACTIONS) {
      assert.match(action, /^[a-z_]+(\.[a-z_]+)+$/, action);
    }
  });
});
