import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAppImage,
  dockerBuild,
  dockerBuildArgv,
  nixpacksArgv,
  redactValues,
  type LogHandler
} from "./index";

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

/** Like `engineFor`, but with build variables attached. */
async function engineForWithArgs(
  mode: "auto" | "dockerfile" | "nixpacks",
  buildArgs: Record<string, string>
): Promise<void> {
  await buildAppImage({
    contextDir: dir,
    imageTag: "sohwe/test:1",
    mode,
    buildArgs,
    onLogLine
  }).catch(() => {
    // As above: the tool is absent, only the logged decisions matter.
  });
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

describe("nixpacksArgv", () => {
  it("puts every build variable behind its own --env flag", () => {
    const argv = nixpacksArgv("/ctx", "img:1", {
      buildArgs: { NIXPACKS_NODE_VERSION: "22", FOO: "bar" }
    });
    assert.deepEqual(argv, [
      "build",
      "/ctx",
      "--name",
      "img:1",
      "--env",
      "NIXPACKS_NODE_VERSION=22",
      "--env",
      "FOO=bar"
    ]);
  });

  it("keeps command overrides and adds nothing when there are no variables", () => {
    assert.deepEqual(
      nixpacksArgv("/ctx", "img:1", { buildCmd: "npm run build", startCmd: " " }),
      ["build", "/ctx", "--name", "img:1", "--build-cmd", "npm run build"]
    );
    assert.deepEqual(nixpacksArgv("/ctx", "img:1"), [
      "build",
      "/ctx",
      "--name",
      "img:1"
    ]);
  });

  it("keeps a value containing '=' intact", () => {
    const argv = nixpacksArgv("/ctx", "img:1", {
      buildArgs: { OPTS: "a=1&b=2" }
    });
    assert.equal(argv.at(-1), "OPTS=a=1&b=2");
  });
});

describe("dockerBuildArgv", () => {
  it("passes build variables by name only, keeping values off the argv", () => {
    const argv = dockerBuildArgv("/ctx", "img:1", { NPM_TOKEN: "npm_secret" });
    assert.deepEqual(argv, [
      "build",
      "-t",
      "img:1",
      "--build-arg",
      "NPM_TOKEN",
      "/ctx"
    ]);
    assert.equal(argv.includes("npm_secret"), false);
  });

  it("keeps the context last so docker still parses it as the context", () => {
    const argv = dockerBuildArgv("/ctx", "img:1", { A: "1", B: "2" });
    assert.equal(argv.at(-1), "/ctx");
  });
});

describe("redactValues", () => {
  it("masks every occurrence of a value", () => {
    assert.equal(
      redactValues("token npm_abcdef and again npm_abcdef", ["npm_abcdef"]),
      "token *** and again ***"
    );
  });

  it("leaves the line alone when there is nothing to mask", () => {
    assert.equal(redactValues("plain line", []), "plain line");
    assert.equal(redactValues("plain line", undefined), "plain line");
  });

  it("ignores values too short to be worth masking", () => {
    // "22" as NIXPACKS_NODE_VERSION would otherwise redact half the build log.
    assert.equal(redactValues("Node 22 selected", ["22"]), "Node 22 selected");
  });
});

describe("buildAppImage — build variable announcement", () => {
  it("logs the keys, sorted, and never the values", async () => {
    await engineForWithArgs("nixpacks", {
      NPM_TOKEN: "npm_supersecret",
      NIXPACKS_NODE_VERSION: "22"
    });
    const line = logs.find((l) => l.startsWith("[sohwe] Build variables:"));
    assert.equal(line, "[sohwe] Build variables: NIXPACKS_NODE_VERSION, NPM_TOKEN");
    assert.equal(
      logs.some((l) => l.includes("npm_supersecret")),
      false
    );
  });

  it("says nothing when there are no build variables", async () => {
    await engineFor("nixpacks");
    assert.equal(
      logs.some((l) => l.startsWith("[sohwe] Build variables:")),
      false
    );
  });

  it("warns that a Dockerfile needs a matching ARG", async () => {
    await addDockerfile();
    await engineForWithArgs("dockerfile", { NIXPACKS_NODE_VERSION: "22" });
    assert.equal(
      logs.some((l) => l.includes("declares a matching ARG")),
      true
    );
  });

  it("does not warn about ARG for a nixpacks build", async () => {
    await engineForWithArgs("nixpacks", { NIXPACKS_NODE_VERSION: "22" });
    assert.equal(
      logs.some((l) => l.includes("declares a matching ARG")),
      false
    );
  });
});

describe("buildAppImage — Node version default", () => {
  it("announces the supplied version for an unpinned Node repo", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }), "utf8");
    await engineFor("nixpacks");
    assert.ok(
      logs.some((l) => l.includes("No Node version pinned by this repo")),
      "the substitution must be visible in the build log"
    );
    assert.ok(
      logs.some((l) => l.includes("end-of-life")),
      "the log should say why the default was not used"
    );
  });

  it("stays quiet when the repo pins a version", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", engines: { node: ">=20.9.0" } }),
      "utf8"
    );
    await engineFor("nixpacks");
    assert.equal(
      logs.some((l) => l.includes("No Node version pinned")),
      false
    );
  });

  it("stays quiet for a Dockerfile build, where the base image decides", async () => {
    await addDockerfile();
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }), "utf8");
    await engineFor("auto");
    assert.equal(announcedEngine(), "dockerfile");
    assert.equal(
      logs.some((l) => l.includes("No Node version pinned")),
      false
    );
  });

  it("stays quiet for a repo that is not a Node project", async () => {
    await engineFor("nixpacks");
    assert.equal(
      logs.some((l) => l.includes("No Node version pinned")),
      false
    );
  });
});
