import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectInternalNetworkName } from "@sohwe/types";
import type { RoutingConfig } from "./container-spec";
import {
  buildProjectServiceContainerSpec,
  projectServiceContainerName,
  type ProjectServiceSpec
} from "./project-container-spec";

const PROJECT = {
  id: "11111111-2222-3333-4444-555555555555",
  slug: "fleetoptics"
};
const RELEASE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const DEPLOYMENT = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const ROUTING: RoutingConfig = {
  baseDomain: "apps.example.com",
  network: "sohwe_proxy",
  httpsEnabled: false,
  certResolver: "letsencrypt"
};

function service(overrides: Partial<ProjectServiceSpec>): ProjectServiceSpec {
  return {
    id: "22222222-3333-4444-5555-666666666666",
    slug: "api",
    kind: "http",
    port: 3000,
    runtimeCmd: null,
    memoryLimitMb: null,
    cpuLimit: null,
    restartPolicy: "unless-stopped",
    domains: [],
    ...overrides
  };
}

function spec(value: ProjectServiceSpec) {
  return buildProjectServiceContainerSpec({
    project: PROJECT,
    service: value,
    releaseId: RELEASE,
    serviceDeploymentId: DEPLOYMENT,
    imageTag: "sohwe/fleet:release",
    envList: [],
    routing: ROUTING
  });
}

describe("project service container specs", () => {
  it("routes only HTTP services and labels every identity dimension", () => {
    const result = spec(service({}));
    assert.equal(result.HostConfig?.NetworkMode, "sohwe_proxy");
    assert.equal(result.Labels?.["traefik.enable"], "true");
    assert.equal(result.Labels?.["sohwe.project"], PROJECT.id);
    assert.equal(result.Labels?.["sohwe.service-kind"], "http");
    assert.equal(result.Labels?.["sohwe.release"], RELEASE);
    assert.equal(result.Labels?.["sohwe.service-deployment"], DEPLOYMENT);
    assert.equal("sohwe.app" in (result.Labels ?? {}), false);
  });

  it("keeps workers private with stable project-network DNS", () => {
    const result = spec(service({ kind: "worker", port: null, slug: "worker" }));
    const network = projectInternalNetworkName(PROJECT.id);
    assert.equal(result.HostConfig?.NetworkMode, network);
    assert.equal(result.Labels?.["traefik.enable"], undefined);
    assert.equal(result.ExposedPorts, undefined);
    assert.deepEqual(
      result.NetworkingConfig?.EndpointsConfig?.[network]?.Aliases,
      ["worker"]
    );
  });

  it("makes release jobs one-shot regardless of configured restart policy", () => {
    const result = spec(
      service({ kind: "release", port: null, slug: "migrate", restartPolicy: "always" })
    );
    assert.equal(result.HostConfig?.RestartPolicy?.Name, "no");
    assert.equal(result.Labels?.["sohwe.service-kind"], "release");
  });

  it("uses release-specific container names for safe candidate startup", () => {
    assert.notEqual(
      projectServiceContainerName(PROJECT.slug, "api", RELEASE),
      projectServiceContainerName(
        PROJECT.slug,
        "api",
        "cccccccc-dddd-eeee-ffff-000000000000"
      )
    );
  });

  it("configures bounded Docker log rotation", () => {
    assert.deepEqual(spec(service({})).HostConfig?.LogConfig, {
      Type: "json-file",
      Config: { "max-size": "10m", "max-file": "3" }
    });
  });
});
