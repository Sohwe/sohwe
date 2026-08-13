import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appDockerVolumeName, appInternalNetworkName } from "@sohwe/types";
import {
  connectToInternalNetwork,
  ensureAppVolumes,
  stopAndRemoveAppContainers,
  type OpsDocker
} from "./docker-ops";

type Calls = { name: string; args?: unknown }[];

function makeDocker(opts: {
  containers?: { Id: string }[];
  stopFails?: Set<string>;
  removeFails?: Set<string>;
  existingVolumes?: Set<string>;
  networkExists?: boolean;
  connectFails?: boolean;
}): { docker: OpsDocker; calls: Calls } {
  const calls: Calls = [];
  const docker: OpsDocker = {
    listContainers: async (o) => {
      calls.push({ name: "listContainers", args: o });
      return opts.containers ?? [];
    },
    getContainer: (id) => ({
      stop: async (o) => {
        calls.push({ name: `stop:${id}`, args: o });
        if (opts.stopFails?.has(id)) throw new Error("stop timeout");
      },
      remove: async () => {
        calls.push({ name: `remove:${id}` });
        if (opts.removeFails?.has(id)) throw new Error("remove conflict");
      }
    }),
    getVolume: (name) => ({
      inspect: async () => {
        calls.push({ name: `inspectVolume:${name}` });
        if (!opts.existingVolumes?.has(name)) throw new Error("no such volume");
      }
    }),
    createVolume: async (o) => {
      calls.push({ name: "createVolume", args: o });
    },
    createNetwork: async (o) => {
      calls.push({ name: "createNetwork", args: o });
      if (opts.networkExists) throw new Error("network already exists");
    },
    getNetwork: (name) => ({
      connect: async (o) => {
        calls.push({ name: `connect:${name}`, args: o });
        if (opts.connectFails) throw new Error("endpoint join failed");
      }
    })
  };
  return { docker, calls };
}

describe("stopAndRemoveAppContainers", () => {
  it("stops and removes every container of the app, running or not", async () => {
    const { docker, calls } = makeDocker({
      containers: [{ Id: "c1" }, { Id: "c2" }]
    });
    await stopAndRemoveAppContainers(docker, "app-1");

    assert.deepEqual(calls[0], {
      name: "listContainers",
      args: { all: true, filters: { label: ["sohwe.app=app-1"] } }
    });
    assert.deepEqual(
      calls.slice(1).map((c) => c.name),
      ["stop:c1", "remove:c1", "stop:c2", "remove:c2"]
    );
    assert.deepEqual(calls[1]?.args, { t: 10 });
  });

  it("still removes when stop fails, and continues past a failed remove", async () => {
    const { docker, calls } = makeDocker({
      containers: [{ Id: "wedged" }, { Id: "ok" }],
      stopFails: new Set(["wedged"]),
      removeFails: new Set(["wedged"])
    });
    await stopAndRemoveAppContainers(docker, "app-1");
    assert.deepEqual(
      calls.slice(1).map((c) => c.name),
      ["stop:wedged", "remove:wedged", "stop:ok", "remove:ok"]
    );
  });
});

describe("ensureAppVolumes", () => {
  it("creates only the volumes that do not already exist", async () => {
    const existing = appDockerVolumeName("app-1", "vol-a");
    const missing = appDockerVolumeName("app-1", "vol-b");
    const { docker, calls } = makeDocker({
      existingVolumes: new Set([existing])
    });

    await ensureAppVolumes(docker, "app-1", [{ id: "vol-a" }, { id: "vol-b" }]);

    const creates = calls.filter((c) => c.name === "createVolume");
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0]?.args, {
      Name: missing,
      Labels: {
        "sohwe.managed": "true",
        "sohwe.app": "app-1",
        "sohwe.volume": "vol-b"
      }
    });
  });
});

describe("connectToInternalNetwork", () => {
  it("creates the internal network and connects the container", async () => {
    const { docker, calls } = makeDocker({});
    await connectToInternalNetwork(docker, "app-1", "container-1");

    const netName = appInternalNetworkName("app-1");
    assert.deepEqual(calls[0], {
      name: "createNetwork",
      args: {
        Name: netName,
        Driver: "bridge",
        Internal: true,
        Labels: { "sohwe.managed": "true", "sohwe.app": "app-1" }
      }
    });
    assert.deepEqual(calls[1], {
      name: `connect:${netName}`,
      args: { Container: "container-1" }
    });
  });

  it("still connects when the network already exists", async () => {
    const { docker, calls } = makeDocker({ networkExists: true });
    await connectToInternalNetwork(docker, "app-1", "container-1");
    assert.equal(
      calls.at(-1)?.name,
      `connect:${appInternalNetworkName("app-1")}`
    );
  });

  it("propagates a failed connect — that is a failed deploy", async () => {
    const { docker } = makeDocker({ connectFails: true });
    await assert.rejects(
      connectToInternalNetwork(docker, "app-1", "container-1"),
      /endpoint join failed/
    );
  });
});
