import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import { FsError, getLatestAppContainer, normalizeContainerPath } from "./container-fs";

describe("getLatestAppContainer", () => {
  it("selects the newest app container even when it has exited", async () => {
    let filters: unknown;
    const docker = {
      listContainers: async (options: unknown) => {
        filters = options;
        return [
          { Id: "old-running", Created: 100 },
          { Id: "new-exited", Created: 200 }
        ];
      },
      getContainer: (id: string) => ({ id })
    } as unknown as Docker;

    const container = await getLatestAppContainer(docker, "app-1");
    assert.equal(container?.id, "new-exited");
    assert.deepEqual(filters, {
      all: true,
      filters: { label: ["sohwe.app=app-1"] }
    });
  });

  it("returns null when the app has no retained container", async () => {
    const docker = {
      listContainers: async () => []
    } as unknown as Docker;
    assert.equal(await getLatestAppContainer(docker, "app-1"), null);
  });
});

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
