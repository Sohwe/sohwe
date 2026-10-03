import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCheckout, parseBranchRefs } from "./repository-inspection";

async function fixture(files: Record<string, string>, check: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sohwe-inspection-test-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const dest = join(root, path);
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(dest, contents);
    }
    await check(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("repository inspection", () => {
  it("lists branch refs with the remote default first", () => {
    const result = parseBranchRefs([
      "ref: refs/heads/master\tHEAD",
      `${"a".repeat(40)}\trefs/heads/feature/import`,
      `${"b".repeat(40)}\trefs/heads/master`,
      `${"b".repeat(40)}\tHEAD`
    ].join("\n"));
    assert.deepEqual(result, { branches: ["master", "feature/import"], defaultBranch: "master", truncated: false });
  });

  it("caps very large branch lists while retaining the default", () => {
    const refs = Array.from({ length: 110 }, (_, index) => `${"a".repeat(40)}\trefs/heads/branch-${String(index).padStart(3, "0")}`);
    const result = parseBranchRefs(["ref: refs/heads/branch-109\tHEAD", ...refs].join("\n"));
    assert.equal(result.branches.length, 100);
    assert.equal(result.branches[0], "branch-109");
    assert.equal(result.truncated, true);
  });

  it("prefers a root Dockerfile and reports its startup and exposed port", async () => {
    await fixture({ Dockerfile: 'FROM node:24\nEXPOSE 8080\nCMD ["node", "server.js"]\n' }, async (root) => {
      const plan = await inspectCheckout(root, "main", "abc123");
      assert.equal(plan.selected.buildMode, "dockerfile");
      assert.equal(plan.selected.dockerfilePath, "Dockerfile");
      assert.equal(plan.selected.port, 8080);
      assert.match(plan.selected.startDisplay ?? "", /server\.js/);
      assert.equal(plan.buildContext, ".");
    });
  });

  it("uses Nixpacks for a root Node app and suggests its scripts", async () => {
    await fixture({ "package.json": JSON.stringify({ scripts: { build: "vite build", start: "node server.js --port 4173" } }) }, async (root) => {
      const plan = await inspectCheckout(root, "main", "abc123");
      assert.equal(plan.selected.buildMode, "nixpacks");
      assert.equal(plan.selected.startCmd, "npm run start");
      assert.equal(plan.selected.buildCmd, "npm run build");
      assert.equal(plan.selected.port, 4173);
    });
  });

  it("selects a workspace app but keeps the root context and scoped commands", async () => {
    await fixture({
      "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { build: "turbo build" } }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "apps/api/package.json": JSON.stringify({ name: "@example/api", scripts: { build: "tsc", start: "node dist/index.js --port 4000" } })
    }, async (root) => {
      const plan = await inspectCheckout(root, "release", "abc123");
      assert.equal(plan.selected.directory, "apps/api");
      assert.equal(plan.selected.buildMode, "nixpacks");
      assert.equal(plan.selected.buildCmd, 'pnpm --filter "@example/api" build');
      assert.equal(plan.selected.startCmd, 'pnpm --filter "@example/api" start');
      assert.equal(plan.buildContext, ".");
    });
  });

  it("loads a root config and applies its directory and port ahead of detection", async () => {
    await fixture({
      "Dockerfile": "FROM node:24\nEXPOSE 3000\n",
      "apps/api/Dockerfile": "FROM node:24\nEXPOSE 4000\n",
      "sohwe.yaml": "version: 1\napplication:\n  directory: apps/api\n  runtime:\n    port: 8080\n  variables:\n    - key: DATABASE_URL\n      required: true\n",
      ".env": "DATABASE_URL=do-not-read\n"
    }, async (root) => {
      const plan = await inspectCheckout(root, "main", "abc123");
      assert.equal(plan.configPath, "sohwe.yaml");
      assert.equal(plan.selected.directory, "apps/api");
      assert.equal(plan.resolved.values.port, 8080);
      assert.equal(plan.resolved.sources.port, "file");
      assert.equal(plan.buildContext, ".");
      assert.ok(!JSON.stringify(plan).includes("do-not-read"));
    });
  });

  it("supports an explicit nested config and rejects invalid or missing files", async () => {
    await fixture({
      "package.json": "{}",
      "apps/api/sohwe.yaml": "version: 1\napplication:\n  build:\n    mode: nixpacks\n"
    }, async (root) => {
      const plan = await inspectCheckout(root, "main", "abc123", undefined, "apps/api/sohwe.yaml");
      assert.equal(plan.configPath, "apps/api/sohwe.yaml");
      await assert.rejects(() => inspectCheckout(root, "main", "abc123", undefined, "other/sohwe.yaml"), /Config file could not be read/);
      await writeFile(join(root, "apps/api/sohwe.yaml"), "version: 1\napplication:\n  privileged: true\n");
      await assert.rejects(() => inspectCheckout(root, "main", "abc123", undefined, "apps/api/sohwe.yaml"), /apps\/api\/sohwe\.yaml:\d+:\d+:.*privileged/);
    });
  });

  it("does not inspect a symlink outside the checkout", async () => {
    await fixture({ "package.json": "{}" }, async (root) => {
      await symlink(tmpdir(), join(root, "apps"));
      await assert.rejects(() => inspectCheckout(root, "main", "abc123", "apps"), /does not exist/);
    });
  });
});
