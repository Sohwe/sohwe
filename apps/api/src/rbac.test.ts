import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasRole, roleRank } from "./rbac";

describe("role ranking", () => {
  it("orders owner above admin above member", () => {
    assert.ok(roleRank("owner") > roleRank("admin"));
    assert.ok(roleRank("admin") > roleRank("member"));
  });

  it("gives an unknown role no privileges at all", () => {
    // A role string this build does not understand — a downgrade, a typo, or a
    // hand-edited row — must not be treated as valid, let alone privileged.
    assert.equal(roleRank("superuser"), 0);
    assert.equal(roleRank(""), 0);
    assert.equal(hasRole("superuser", "member"), false);
    assert.equal(hasRole("Owner", "member"), false, "role matching is case-sensitive");
  });

  it("treats a role as satisfying itself", () => {
    assert.ok(hasRole("member", "member"));
    assert.ok(hasRole("admin", "admin"));
    assert.ok(hasRole("owner", "owner"));
  });

  it("lets higher roles satisfy lower requirements", () => {
    assert.ok(hasRole("owner", "admin"));
    assert.ok(hasRole("owner", "member"));
    assert.ok(hasRole("admin", "member"));
  });

  it("does not let lower roles satisfy higher requirements", () => {
    assert.equal(hasRole("member", "admin"), false);
    assert.equal(hasRole("member", "owner"), false);
    assert.equal(hasRole("admin", "owner"), false);
  });
});
