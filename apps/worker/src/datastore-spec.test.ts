import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDatastoreContainerSpec,
  buildDatastoreLabels,
  datastoreDataPath,
  datastoreImage,
  type DatastoreSpecInput
} from "./datastore-spec";

// The datastore spec decides what `docker.createContainer` receives for a
// managed Postgres/Redis. The invariants pinned here are security boundaries:
// no Traefik exposure, no `sohwe.app` label (which would pull the container
// into the per-app log/stats/crash subsystems), and no published ports unless
// the operator opted in.

function input(overrides: Partial<DatastoreSpecInput> = {}): DatastoreSpecInput {
  return {
    id: "ds-1",
    slug: "main-db",
    kind: "postgres",
    engineVersion: "16",
    memoryLimitMb: null,
    cpuLimit: null,
    publicPort: null,
    creds: { username: "sohwe", password: "pw123", database: "main_db" },
    ...overrides
  };
}

describe("datastoreImage / datastoreDataPath", () => {
  it("maps kind + engine version to the official image", () => {
    assert.equal(datastoreImage("postgres", "16"), "postgres:16");
    assert.equal(datastoreImage("redis", "7"), "redis:7");
  });

  it("mounts the data volume at the engine's data directory", () => {
    assert.equal(datastoreDataPath("postgres"), "/var/lib/postgresql/data");
    assert.equal(datastoreDataPath("redis"), "/data");
  });
});

describe("buildDatastoreContainerSpec (postgres)", () => {
  it("names the container, sets the image, and passes credentials as env", () => {
    const spec = buildDatastoreContainerSpec(input());
    assert.equal(spec.name, "sohwe-ds-main-db");
    assert.equal(spec.Image, "postgres:16");
    assert.deepEqual(spec.Env, [
      "POSTGRES_USER=sohwe",
      "POSTGRES_PASSWORD=pw123",
      "POSTGRES_DB=main_db"
    ]);
  });

  it("binds the id-derived data volume", () => {
    const spec = buildDatastoreContainerSpec(input());
    assert.deepEqual(spec.HostConfig?.Binds, [
      "sohwe_datastore_ds-1_data:/var/lib/postgresql/data"
    ]);
  });

  it("labels the container as managed with the datastore id and NO sohwe.app", () => {
    const labels = buildDatastoreContainerSpec(input()).Labels!;
    assert.equal(labels["sohwe.managed"], "true");
    assert.equal(labels["sohwe.datastore"], "ds-1");
    assert.equal("sohwe.app" in labels, false);
    assert.deepEqual(buildDatastoreLabels("ds-1"), labels);
  });

  it("emits no Traefik labels and no exposed ports when private", () => {
    const spec = buildDatastoreContainerSpec(input());
    assert.ok(!Object.keys(spec.Labels!).some((k) => k.startsWith("traefik.")));
    assert.equal(spec.ExposedPorts, undefined);
    assert.equal(spec.HostConfig?.PortBindings, undefined);
  });

  it("applies resource limits through the shared helper semantics", () => {
    const spec = buildDatastoreContainerSpec(
      input({ memoryLimitMb: 1024, cpuLimit: 2 })
    );
    assert.equal(spec.HostConfig?.Memory, 1024 * 1024 * 1024);
    assert.equal(spec.HostConfig?.NanoCpus, 2e9);
    const unset = buildDatastoreContainerSpec(input());
    assert.equal(unset.HostConfig?.Memory, undefined);
    assert.equal(unset.HostConfig?.NanoCpus, undefined);
  });

  it("restarts unless stopped", () => {
    const spec = buildDatastoreContainerSpec(input());
    assert.deepEqual(spec.HostConfig?.RestartPolicy, { Name: "unless-stopped" });
  });
});

describe("buildDatastoreContainerSpec (redis)", () => {
  it("enables AOF persistence and requirepass via Cmd, with no Env", () => {
    const spec = buildDatastoreContainerSpec(
      input({ kind: "redis", engineVersion: "7", slug: "cache", creds: { password: "rpw" } })
    );
    assert.equal(spec.Image, "redis:7");
    assert.deepEqual(spec.Cmd, [
      "redis-server",
      "--appendonly",
      "yes",
      "--requirepass",
      "rpw"
    ]);
    assert.equal(spec.Env, undefined);
    assert.deepEqual(spec.HostConfig?.Binds, ["sohwe_datastore_ds-1_data:/data"]);
  });
});

describe("public access", () => {
  it("publishes exactly the assigned host port on 0.0.0.0", () => {
    const spec = buildDatastoreContainerSpec(input({ publicPort: 24001 }));
    assert.deepEqual(spec.ExposedPorts, { "5432/tcp": {} });
    assert.deepEqual(spec.HostConfig?.PortBindings, {
      "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "24001" }]
    });
  });

  it("maps the redis service port when public", () => {
    const spec = buildDatastoreContainerSpec(
      input({ kind: "redis", creds: { password: "rpw" }, publicPort: 25000 })
    );
    assert.deepEqual(spec.ExposedPorts, { "6379/tcp": {} });
    assert.deepEqual(spec.HostConfig?.PortBindings, {
      "6379/tcp": [{ HostIp: "0.0.0.0", HostPort: "25000" }]
    });
  });
});
