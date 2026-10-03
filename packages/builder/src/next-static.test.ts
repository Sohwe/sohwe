import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectNextStaticExport, nextStaticServerSource } from "./next-static";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "sohwe-next-static-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function nextApp(start = "next start", config = 'export default { output: "export" };'): Promise<void> {
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "^16" }, scripts: { start } }));
  await writeFile(join(root, "next.config.ts"), config);
}

describe("Next.js static export detection", () => {
  it("recognizes an exported app even when npm start points at next start", async () => {
    await nextApp();
    assert.equal(detectNextStaticExport(root, root), "out");
    assert.equal(detectNextStaticExport(root, root, "npm run start"), "out");
  });

  it("handles a nested app and a literal custom output directory", async () => {
    const appDir = join(root, "apps", "web");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "package.json"), JSON.stringify({ dependencies: { next: "16" } }));
    await writeFile(join(appDir, "next.config.mjs"), "export default { output: 'export', distDir: 'site' };");
    assert.equal(detectNextStaticExport(root, appDir), "apps/web/site");
  });

  it("preserves an explicit server command and non-exported apps", async () => {
    await nextApp();
    assert.equal(detectNextStaticExport(root, root, "node server.js"), null);
    await nextApp("serve out");
    assert.equal(detectNextStaticExport(root, root), null);
    await nextApp("next start", "export default { output: 'standalone' };");
    assert.equal(detectNextStaticExport(root, root), null);
  });

  it("bundles a static server for the routed port", () => {
    const source = nextStaticServerSource("out", 3000);
    assert.ok(source.startsWith('const SOHWE_STATIC_ROOT = "/app/out";\nconst SOHWE_STATIC_PORT = 3000;'));
    assert.throws(() => nextStaticServerSource("out", 0), /port/);
  });

  it("serves exported routes and keeps symlinks outside the export private", async () => {
    const out = join(root, "out");
    await mkdir(join(out, "docs"), { recursive: true });
    await writeFile(join(out, "index.html"), "home");
    await writeFile(join(out, "docs", "index.html"), "docs");
    await writeFile(join(out, "flat.html"), "flat");
    await writeFile(join(out, "404.html"), "missing");
    await writeFile(join(root, "private.txt"), "secret");
    await symlink(join(root, "private.txt"), join(out, "leak.txt"));

    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const address = socket.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));

    const script = join(root, "server.cjs");
    await writeFile(script, nextStaticServerSource("out", port, root));
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Static server did not start")), 3000);
        child.stdout.on("data", () => { clearTimeout(timer); resolve(); });
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`Static server exited ${code}`)));
      });
      for (const [path, status, body] of [
        ["/", 200, "home"],
        ["/docs/", 200, "docs"],
        ["/flat", 200, "flat"],
        ["/missing", 404, "missing"],
        ["/leak.txt", 404, "missing"]
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        assert.equal(response.status, status, path);
        assert.equal(await response.text(), body, path);
      }
    } finally {
      child.kill();
    }
  });
});
