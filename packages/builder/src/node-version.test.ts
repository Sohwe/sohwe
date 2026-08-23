import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_NODE_VERSION,
  NODE_VERSION_KEY,
  resolveNodeVersion
} from "./node-version";

// Nixpacks resolves a Node version from NIXPACKS_NODE_VERSION, then
// engines.node, then .nvmrc, then .node-version, then its own default of 18.
// These tests pin the rule that Sohwe steps in for the last case only.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sohwe-node-version-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writePackageJson(contents: unknown): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify(contents), "utf8");
}

describe("resolveNodeVersion", () => {
  it("supplies a default for a Node repo that pins nothing", async () => {
    await writePackageJson({ name: "app", dependencies: { next: "16.2.9" } });
    assert.deepEqual(resolveNodeVersion(dir), {
      applied: true,
      version: DEFAULT_NODE_VERSION
    });
  });

  it("defers to an explicit build variable", async () => {
    await writePackageJson({ name: "app" });
    assert.deepEqual(
      resolveNodeVersion(dir, { [NODE_VERSION_KEY]: "20" }),
      { applied: false, reason: "explicit" }
    );
  });

  it("defers to engines.node", async () => {
    await writePackageJson({ name: "app", engines: { node: ">=20.9.0" } });
    assert.deepEqual(resolveNodeVersion(dir), {
      applied: false,
      reason: "repo-pinned"
    });
  });

  it("defers to .nvmrc", async () => {
    await writePackageJson({ name: "app" });
    await writeFile(join(dir, ".nvmrc"), "lts/iron\n", "utf8");
    assert.deepEqual(resolveNodeVersion(dir), {
      applied: false,
      reason: "repo-pinned"
    });
  });

  it("defers to .node-version", async () => {
    await writePackageJson({ name: "app" });
    await writeFile(join(dir, ".node-version"), "v20.11.0\n", "utf8");
    assert.deepEqual(resolveNodeVersion(dir), {
      applied: false,
      reason: "repo-pinned"
    });
  });

  it("does nothing for a repo with no package.json", () => {
    assert.deepEqual(resolveNodeVersion(dir), {
      applied: false,
      reason: "not-node"
    });
  });

  it('treats engines.node of "*" as no pin, exactly as nixpacks does', async () => {
    // Nixpacks maps "*" back to its own default of 18, so honoring it as a pin
    // would leave the repo on an end-of-life runtime.
    await writePackageJson({ name: "app", engines: { node: "*" } });
    assert.deepEqual(resolveNodeVersion(dir), {
      applied: true,
      version: DEFAULT_NODE_VERSION
    });
  });

  it("treats an empty or whitespace-only pin as no pin", async () => {
    await writePackageJson({ name: "app", engines: { node: "  " } });
    await writeFile(join(dir, ".nvmrc"), "\n", "utf8");
    assert.deepEqual(resolveNodeVersion(dir), {
      applied: true,
      version: DEFAULT_NODE_VERSION
    });
  });

  it("ignores an empty explicit build variable", async () => {
    await writePackageJson({ name: "app" });
    assert.deepEqual(resolveNodeVersion(dir, { [NODE_VERSION_KEY]: "" }), {
      applied: true,
      version: DEFAULT_NODE_VERSION
    });
  });

  it("still supplies a default when package.json is malformed", async () => {
    // Nixpacks will report the syntax error; that is not a reason to also hand
    // the build an end-of-life runtime.
    await writeFile(join(dir, "package.json"), "{ not json", "utf8");
    assert.deepEqual(resolveNodeVersion(dir), {
      applied: true,
      version: DEFAULT_NODE_VERSION
    });
  });

  it("ignores a non-string or non-object engines field", async () => {
    await writePackageJson({ name: "app", engines: { node: 20 } });
    assert.deepEqual(resolveNodeVersion(dir), {
      applied: true,
      version: DEFAULT_NODE_VERSION
    });

    await writePackageJson({ name: "app", engines: "nonsense" });
    assert.deepEqual(resolveNodeVersion(dir), {
      applied: true,
      version: DEFAULT_NODE_VERSION
    });
  });

  it("uses a version nixpacks actually supports", () => {
    // AVAILABLE_NODE_VERSIONS in the nixpacks Node provider; an unsupported
    // request silently falls back to 18, which would defeat the whole point.
    assert.ok(["14", "16", "18", "20", "22", "24"].includes(DEFAULT_NODE_VERSION));
  });
});
