import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAppImage, dockerBuild, type LogHandler } from "./index";

/**
 * Engine selection is the part of the builder that can be tested without a
 * Docker daemon or a Nixpacks install: it is decided purely by the build mode
 * and whether a Dockerfile exists in the context directory.
 *
 * The tests stop at the point where a real tool would be spawned. `docker` and
 * `nixpacks` are almost certainly absent here, and `runTool` turns a missing
 * binary into a specific error, so the assertions match on *which* tool was
 * reached rather than on a successful build.
 */

let dir: string;
const logs: string[] = [];
const onLogLine: LogHandler = (l) => logs.push(l);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sohwe-builder-test-"));
  logs.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function addDockerfile(): Promise<void> {
  await writeFile(join(dir, "Dockerfile"), "FROM scratch\n", "utf8");
}

/** Which engine a build attempt reached, inferred from its announcement line. */
function announcedEngine(): "dockerfile" | "nixpacks" | null {
  const line = logs.find((l) => l.startsWith("[sohwe] Engine:"));
  if (!line) return null;
  return line.includes("docker build") ? "dockerfile" : "nixpacks";
}

/** Run a build and report the engine it announced, swallowing the tool failure. */
async function engineFor(
  mode: "auto" | "dockerfile" | "nixpacks"
): Promise<"dockerfile" | "nixpacks" | null> {
  await buildAppImage({
    contextDir: dir,
    imageTag: "sohwe/test:1",
    mode,
    onLogLine
  }).catch(() => {
    // The tool is not installed here, and may not be; only the choice matters.
  });
  return announcedEngine();
}

describe("buildAppImage — engine selection", () => {
  it("auto prefers a Dockerfile when one exists", async () => {
    await addDockerfile();
    assert.equal(await engineFor("auto"), "dockerfile");
  });

  it("auto falls back to nixpacks with no Dockerfile", async () => {
    assert.equal(await engineFor("nixpacks"), "nixpacks");
    logs.length = 0;
    assert.equal(await engineFor("auto"), "nixpacks");
  });

  it("nixpacks ignores a Dockerfile that is present", async () => {
    await addDockerfile();
    assert.equal(await engineFor("nixpacks"), "nixpacks");
  });

  it("dockerfile mode uses the Dockerfile", async () => {
    await addDockerfile();
    assert.equal(await engineFor("dockerfile"), "dockerfile");
  });

  it("says so in the log when auto had to guess the runtime", async () => {
    await engineFor("auto");
    assert.ok(
      logs.some((l) => l.includes("no Dockerfile found; auto-detecting runtime")),
      "expected the auto fallback to be explained in the build log"
    );
  });

  it("warns that command overrides are ignored in Dockerfile mode", async () => {
    // Silently dropping them would make a user think their override ran.
    await addDockerfile();
    await buildAppImage({
      contextDir: dir,
      imageTag: "sohwe/test:1",
      mode: "auto",
      buildCmd: "npm run build",
      onLogLine
    }).catch(() => {});
    assert.ok(logs.some((l) => l.includes("overrides are ignored in Dockerfile mode")));
  });

  it("does not warn about overrides when none were given", async () => {
    await addDockerfile();
    await engineFor("auto");
    assert.ok(!logs.some((l) => l.includes("overrides are ignored")));
  });
});

describe("buildAppImage — dockerfile mode without a Dockerfile", () => {
  it("fails before spawning anything, naming the cause", async () => {
    await assert.rejects(
      buildAppImage({
        contextDir: dir,
        imageTag: "sohwe/test:1",
        mode: "dockerfile",
        onLogLine
      }),
      /no Dockerfile was found at the repo root/
    );
    // No engine announcement: the mode was rejected before selection.
    assert.equal(announcedEngine(), null);
  });
});

describe("dockerBuild", () => {
  it("refuses a context with no Dockerfile", async () => {
    await assert.rejects(
      dockerBuild({ contextDir: dir, imageTag: "sohwe/test:1", onLogLine }),
      /No Dockerfile in repository root/
    );
  });

  it("only looks for a Dockerfile at the context root", async () => {
    // A Dockerfile nested in a subdirectory is not a root Dockerfile.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "docker"));
    await writeFile(join(dir, "docker", "Dockerfile"), "FROM scratch\n", "utf8");
    await assert.rejects(
      dockerBuild({ contextDir: dir, imageTag: "sohwe/test:1", onLogLine }),
      /No Dockerfile in repository root/
    );
  });
});
