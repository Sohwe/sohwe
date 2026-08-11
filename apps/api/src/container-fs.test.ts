import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FsError, normalizeContainerPath } from "./container-fs";

/**
 * `normalizeContainerPath` is the only thing between a user-supplied string and
 * a path interpolated into a shell script that runs inside their container, so
 * the traversal and shape rules get explicit coverage.
 */

function rejects(raw: string, status = 400): void {
  assert.throws(
    () => normalizeContainerPath(raw),
    (err: unknown) => err instanceof FsError && err.statusCode === status,
    `expected ${JSON.stringify(raw)} to be rejected`
  );
}

describe("normalizeContainerPath", () => {
  it("keeps an already-normal absolute path", () => {
    assert.equal(normalizeContainerPath("/app/src/index.js"), "/app/src/index.js");
  });

  it("collapses repeated and trailing slashes", () => {
    assert.equal(normalizeContainerPath("/app//src///"), "/app/src");
    assert.equal(normalizeContainerPath("///"), "/");
  });

  it("normalizes the root", () => {
    assert.equal(normalizeContainerPath("/"), "/");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(normalizeContainerPath("  /app  "), "/app");
  });

  it("rejects relative paths", () => {
    rejects("app/src");
    rejects("");
    rejects("   ");
    rejects("./app");
    rejects("../etc/passwd");
  });

  it("rejects traversal segments anywhere in the path", () => {
    rejects("/app/../etc/passwd");
    rejects("/..");
    rejects("/app/..");
    rejects("/app/../../root");
    rejects("/a/b/../../../etc/shadow");
  });

  it("allows names that merely contain dots", () => {
    assert.equal(normalizeContainerPath("/app/.env"), "/app/.env");
    assert.equal(normalizeContainerPath("/app/..hidden"), "/app/..hidden");
    assert.equal(normalizeContainerPath("/app/a..b"), "/app/a..b");
    assert.equal(normalizeContainerPath("/app/..."), "/app/...");
  });

  it("keeps a single-dot segment as a literal name", () => {
    // Only ".." is a traversal; "." is left alone rather than silently dropped.
    assert.equal(normalizeContainerPath("/app/./x"), "/app/./x");
  });

  it("rejects paths beyond the length limit", () => {
    const long = `/${"a".repeat(4096)}`;
    rejects(long);
    assert.equal(normalizeContainerPath(`/${"a".repeat(4000)}`).length, 4001);
  });
});
