import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSohweConfig } from "./config-file";
import { parseSohweConfig, resolveSohwePlan, type PlanValues } from "./config";
import { missingRequiredVariables } from "./required-variables";

const sample = `version: 1
application:
  name: API
  directory: apps/api
  build:
    mode: dockerfile
    dockerfile: apps/api/Dockerfile
  runtime:
    port: 8080
  variables:
    - key: DATABASE_URL
      scope: runtime
      required: true
    - key: PUBLIC_API_URL
      scope: both
      required: true
`;

describe("sohwe.yaml v1", () => {
  it("resolves dashboard overrides, then file values, then repository detection", () => {
    const config = parseSohweConfig(sample);
    const detected: PlanValues = { appDirectory: ".", buildMode: "nixpacks", dockerfilePath: "Dockerfile", dockerTarget: null, buildCmd: "npm run build", startCmd: "npm run start", runtimeCmd: null, port: 3000 };
    const saved = { ...detected, port: 9090 };
    const resolved = resolveSohwePlan(detected, config, ["port"], saved);
    assert.equal(resolved.values.port, 9090);
    assert.equal(resolved.sources.port, "override");
    assert.equal(resolved.values.appDirectory, "apps/api");
    assert.equal(resolved.sources.appDirectory, "file");
    assert.equal(resolved.values.startCmd, "npm run start");
    assert.equal(resolved.sources.startCmd, "detected");
  });

  it("requires values in each declared scope without accepting an empty value", () => {
    const config = parseSohweConfig(sample);
    assert.deepEqual(missingRequiredVariables(config, {}, {}), ["DATABASE_URL", "PUBLIC_API_URL"]);
    assert.deepEqual(missingRequiredVariables(config, { DATABASE_URL: "postgres://db", PUBLIC_API_URL: "https://example.test" }, {}), ["PUBLIC_API_URL"]);
    assert.deepEqual(missingRequiredVariables(config, { DATABASE_URL: "postgres://db", PUBLIC_API_URL: "https://example.test" }, { PUBLIC_API_URL: "https://example.test" }), []);
  });

  it("rejects unknown fields, variable values, aliases, tags, and unsupported versions with positions", () => {
    assert.throws(() => parseSohweConfig(sample.replace("port: 8080", "ports: 8080")), /sohwe\.yaml:\d+:\d+:.*ports/);
    assert.throws(() => parseSohweConfig(sample.replace("required: true", "required: true\n      value: secret")), /sohwe\.yaml:\d+:\d+:.*value/);
    assert.throws(() => parseSohweConfig("version: 2\napplication: {}\n"), /sohwe\.yaml:\d+:\d+:.*version/);
    assert.throws(() => parseSohweConfig("version: 1\napplication: &app {}\ncopy: *app\n"), /YAML aliases and tags are not supported/);
    assert.throws(() => parseSohweConfig("version: 1\napplication: !run {}\n"), /YAML aliases and tags are not supported/);
  });

  it("keeps file paths inside the checkout and enforces the size limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "sohwe-config-test-"));
    const outside = await mkdtemp(join(tmpdir(), "sohwe-config-outside-"));
    try {
      await mkdir(join(root, "apps/api"), { recursive: true });
      await writeFile(join(root, "apps/api/sohwe.yaml"), sample);
      assert.equal((await loadSohweConfig(root, "apps/api/sohwe.yaml", true))?.application.directory, "apps/api");
      await writeFile(join(outside, "sohwe.yaml"), sample);
      await symlink(join(outside, "sohwe.yaml"), join(root, "sohwe.yaml"));
      await assert.rejects(() => loadSohweConfig(root, "sohwe.yaml", true), /leaves the repository/);
      await assert.rejects(() => loadSohweConfig(root, "../outside/sohwe.yaml", true));
      await writeFile(join(root, "apps/api/sohwe.yaml"), "a".repeat(64 * 1024 + 1));
      await assert.rejects(() => loadSohweConfig(root, "apps/api/sohwe.yaml", true), /64 KiB/);
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it("keeps the published examples valid and the JSON Schema parseable", async () => {
    const docs = join(process.cwd(), "../../docs");
    for (const name of ["sohwe-root-dockerfile.yaml", "sohwe-monorepo.yaml", "sohwe-nixpacks.yaml"]) {
      assert.equal(parseSohweConfig(await readFile(join(docs, "examples", name), "utf8")).version, 1);
    }
    const schema = JSON.parse(await readFile(join(docs, "schemas/sohwe.v1.schema.json"), "utf8")) as { properties: { version: { const: number } } };
    assert.equal(schema.properties.version.const, 1);
  });
});
