import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectInternalNetworkName } from "@sohwe/types";
import type { RoutingConfig } from "./container-spec";
import {
  buildProjectServiceContainerSpec,
  projectServiceContainerName,
  type ProjectServiceSpec
} from "./project-container-spec";
import { orderRuntimeServices } from "./project-deploy";

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
    healthCheckCmd: null,
    healthCheckIntervalSeconds: 10,
    healthCheckTimeoutSeconds: 5,
    healthCheckRetries: 3,
    healthCheckStartPeriodSeconds: 2,
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
    assert.equal(result.HostConfig?.NetworkMode, projectInternalNetworkName(PROJECT.id));
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

  it("installs a configurable Docker health check", () => {
    const result = spec(
      service({
        healthCheckCmd: "node healthcheck.js",
        healthCheckIntervalSeconds: 7,
        healthCheckTimeoutSeconds: 3,
        healthCheckRetries: 5,
        healthCheckStartPeriodSeconds: 20
      })
    );
    assert.deepEqual(result.Healthcheck, {
      Test: ["CMD-SHELL", "node healthcheck.js"],
      Interval: 7_000_000_000,
      Timeout: 3_000_000_000,
      Retries: 5,
      StartPeriod: 20_000_000_000
    });
  });
});

describe("project service dependency order", () => {
  const orderedService = (
    id: string,
    kind: string,
    dependencies: { id: string; slug: string; kind: string }[] = []
  ) => ({
    id,
    slug: id,
    kind,
    dependencies: dependencies.map((dependency) => ({
      condition: "healthy",
      dependencyService: dependency
    }))
  });

  it("starts API before Chale Check web and workers", () => {
    const api = orderedService("api", "http");
    const web = orderedService("web", "http", [api]);
    const worker = orderedService("worker", "worker", [api]);
    const migrate = orderedService("migrate", "release");
    assert.deepEqual(
      orderRuntimeServices([worker, migrate, web, api]).map((item) => item.id),
      ["api", "worker", "web"]
    );
  });

  it("rejects cycles and dependencies on release jobs", () => {
    const a = orderedService("a", "worker", [
      { id: "b", slug: "b", kind: "worker" }
    ]);
    const b = orderedService("b", "worker", [
      { id: "a", slug: "a", kind: "worker" }
    ]);
    assert.throws(() => orderRuntimeServices([a, b]), /cycle/);

    const release = orderedService("migrate", "release");
    const worker = orderedService("worker", "worker", [release]);
    assert.throws(() => orderRuntimeServices([release, worker]), /unavailable/);
  });
});
