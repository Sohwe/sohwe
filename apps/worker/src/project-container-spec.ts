import { createHash } from "node:crypto";
import type Docker from "dockerode";
import type { ServiceKind } from "@sohwe/types";
import { projectInternalNetworkName } from "@sohwe/types";
import {
  buildResourceLimits,
  buildTraefikLabels,
  type RoutingConfig
} from "./container-spec";

export type ProjectServiceSpec = {
  id: string;
  slug: string;
  kind: ServiceKind;
  port: number | null;
  runtimeCmd: string | null;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  restartPolicy: string;
  healthCheckCmd: string | null;
  healthCheckIntervalSeconds: number;
  healthCheckTimeoutSeconds: number;
  healthCheckRetries: number;
  healthCheckStartPeriodSeconds: number;
  domains: { hostname: string }[];
};

export type ProjectSpec = { id: string; slug: string };

/** Release-specific names let a candidate release start before the old one is removed. */
export function projectServiceContainerName(
  projectSlug: string,
  serviceSlug: string,
  releaseId: string
): string {
  const digest = createHash("sha256").update(releaseId).digest("hex").slice(0, 8);
  const stem = `sohwe-${projectSlug}-${serviceSlug}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${stem.slice(0, 54)}-${digest}`;
}

export function projectServiceLabels(input: {
  project: ProjectSpec;
  service: ProjectServiceSpec;
  releaseId: string;
  serviceDeploymentId: string;
  routing: RoutingConfig;
}): Record<string, string> {
  const { project, service, releaseId, serviceDeploymentId, routing } = input;
  let labels: Record<string, string> = {
    "sohwe.managed": "true",
    "sohwe.project": project.id,
    "sohwe.service": service.id,
    "sohwe.release": releaseId,
    "sohwe.service-deployment": serviceDeploymentId,
    "sohwe.service-kind": service.kind
  };

  if (service.kind === "http") {
    if (!service.port) throw new Error(`HTTP service ${service.slug} has no port`);
    // The existing routing policy remains the single source of truth for TLS,
    // redirect, and Traefik network behavior. Project/service slugs form a
    // globally unique generated route without claiming an Application slug.
    labels = {
      ...buildTraefikLabels({
        app: {
          id: service.id,
          slug: `${project.slug}-${service.slug}`,
          port: service.port,
          runtimeCmd: service.runtimeCmd,
          domains: service.domains.map((d) => ({
            hostname: d.hostname,
            redirectTo: null
          })),
          memoryLimitMb: service.memoryLimitMb,
          cpuLimit: service.cpuLimit
        },
        deploymentId: serviceDeploymentId,
        routing
      }),
      ...labels
    };
    delete labels["sohwe.app"];
    delete labels["sohwe.deployment"];
  }
  return labels;
}

/** Complete Docker spec for HTTP, worker, and one-shot release services. */
export function buildProjectServiceContainerSpec(input: {
  project: ProjectSpec;
  service: ProjectServiceSpec;
  releaseId: string;
  serviceDeploymentId: string;
  imageTag: string;
  envList: string[];
  routing: RoutingConfig;
}): Docker.ContainerCreateOptions {
  const {
    project,
    service,
    releaseId,
    serviceDeploymentId,
    imageTag,
    envList,
    routing
  } = input;
  const privateNetwork = projectInternalNetworkName(project.id);
  const isHttp = service.kind === "http";
  const restartName =
    service.kind === "release" ? "no" : service.restartPolicy || "unless-stopped";

  return {
    name: projectServiceContainerName(project.slug, service.slug, releaseId),
    Image: imageTag,
    Cmd: service.runtimeCmd?.trim()
      ? ["/bin/sh", "-lc", service.runtimeCmd.trim()]
      : undefined,
    Labels: projectServiceLabels({
      project,
      service,
      releaseId,
      serviceDeploymentId,
      routing
    }),
    ExposedPorts:
      isHttp && service.port ? { [`${service.port}/tcp`]: {} } : undefined,
    Env: envList.length > 0 ? envList : undefined,
    Healthcheck: service.healthCheckCmd
      ? {
          Test: ["CMD-SHELL", service.healthCheckCmd],
          Interval: service.healthCheckIntervalSeconds * 1_000_000_000,
          Timeout: service.healthCheckTimeoutSeconds * 1_000_000_000,
          Retries: service.healthCheckRetries,
          StartPeriod: service.healthCheckStartPeriodSeconds * 1_000_000_000
        }
      : undefined,
    HostConfig: {
      // Every candidate starts privately. A healthy HTTP candidate joins the
      // Traefik network only at the promotion boundary.
      NetworkMode: privateNetwork,
      RestartPolicy: {
        Name: restartName as "no" | "on-failure" | "unless-stopped" | "always"
      },
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" }
      },
      ...buildResourceLimits(service)
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [privateNetwork]: { Aliases: [service.slug] }
      }
    }
  };
}
