import type { FastifyInstance } from "fastify";
import Docker from "dockerode";
import IORedis from "ioredis";
import { prisma } from "@sohwe/db";
import { encryptJson } from "@sohwe/crypto";
import { parseGitHubRepoUrl, repoFullName } from "@sohwe/github";
import {
  createProjectDeployQueue,
  getRedisUrl,
  projectLogChannelName
} from "@sohwe/queue";
import {
  BuildArgsPatchSchema,
  CreateProjectSchema,
  CreateServiceSchema,
  EnvVarsPatchSchema,
  EnvVarsReplaceSchema,
  ProjectRollbackBodySchema,
  ServiceDomainsReplaceSchema,
  ServiceLogsQuerySchema,
  UpdateProjectSchema,
  UpdateServiceSchema,
  projectInternalNetworkName
} from "@sohwe/types";
import { z } from "zod";
import { recordAudit } from "../audit";
import { isUniqueViolation } from "../prisma-errors";
import { requireRole } from "../rbac";
import { autoDeployBlocker } from "./applications";
import { applyVarPatch, encodeVarBlob, readVarBlob } from "./variable-store";

const IdParam = z.object({ id: z.string().uuid() });
const ServiceParam = z.object({ serviceId: z.string().uuid() });
const ReleaseParam = z.object({ releaseId: z.string().uuid() });
const docker = new Docker();

const serviceSelect = {
  id: true,
  projectId: true,
  name: true,
  slug: true,
  kind: true,
  buildMode: true,
  buildCmd: true,
  startCmd: true,
  runtimeCmd: true,
  serviceDirectory: true,
  workspaceSelector: true,
  dockerfilePath: true,
  dockerTarget: true,
  imageGroup: true,
  port: true,
  memoryLimitMb: true,
  cpuLimit: true,
  restartPolicy: true,
  healthCheckCmd: true,
  healthCheckIntervalSeconds: true,
  healthCheckTimeoutSeconds: true,
  healthCheckRetries: true,
  healthCheckStartPeriodSeconds: true,
  dependencies: {
    orderBy: { createdAt: "asc" as const },
    select: {
      condition: true,
      dependencyService: {
        select: { id: true, name: true, slug: true, kind: true }
      }
    }
  },
  domains: {
    orderBy: [{ isPrimary: "desc" as const }, { createdAt: "asc" as const }],
    select: { id: true, hostname: true, isPrimary: true, createdAt: true }
  },
  createdAt: true,
  updatedAt: true
};

const releaseSelect = {
  id: true,
  projectId: true,
  commitSha: true,
  commitMessage: true,
  trigger: true,
  sourceReleaseId: true,
  status: true,
  errorMessage: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  serviceDeployments: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      serviceId: true,
      imageTag: true,
      status: true,
      errorMessage: true,
      exitCode: true,
      containerId: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
      service: { select: { name: true, slug: true, kind: true } }
    }
  }
};

function projectSelect(releaseTake = 20) {
  return {
    id: true,
    organizationId: true,
    name: true,
    slug: true,
    gitRepo: true,
    gitBranch: true,
    repoFullName: true,
    autoDeploy: true,
    status: true,
    currentReleaseId: true,
    createdAt: true,
    updatedAt: true,
    services: { orderBy: { createdAt: "asc" as const }, select: serviceSelect },
    datastoreBindings: {
      orderBy: { createdAt: "asc" as const },
      select: {
        id: true,
        datastoreId: true,
        envKey: true,
        serviceIds: true,
        createdAt: true,
        datastore: {
          select: { id: true, name: true, slug: true, kind: true, status: true }
        }
      }
    },
    releases: {
      orderBy: { createdAt: "desc" as const },
      take: releaseTake,
      select: releaseSelect
    }
  };
}

type DependencyGraphService = {
  id: string;
  slug: string;
  kind: string;
  dependencies: { dependencyServiceId: string }[];
};

function validateDependencyChange(
  services: DependencyGraphService[],
  serviceId: string,
  dependencies: { serviceSlug: string; condition: "started" | "healthy" }[]
): { error?: string; rows?: { dependencyServiceId: string; condition: string }[] } {
  const current = services.find((service) => service.id === serviceId);
  if (!current) return { error: "Service not found" };
  if (current.kind === "release" && dependencies.length > 0) {
    return { error: "Release services cannot depend on runtime services" };
  }
  const bySlug = new Map(services.map((service) => [service.slug, service]));
  const rows: { dependencyServiceId: string; condition: string }[] = [];
  const seen = new Set<string>();
  for (const dependency of dependencies) {
    const target = bySlug.get(dependency.serviceSlug);
    if (!target) return { error: `Unknown service dependency: ${dependency.serviceSlug}` };
    if (target.id === serviceId) return { error: "A service cannot depend on itself" };
    if (target.kind === "release") {
      return { error: "Runtime services cannot depend on a one-shot release service" };
    }
    if (seen.has(target.id)) {
      return { error: `Service ${dependency.serviceSlug} is listed more than once` };
    }
    seen.add(target.id);
    rows.push({ dependencyServiceId: target.id, condition: dependency.condition });
  }

  const edges = new Map(
    services.map((service) => [
      service.id,
      service.id === serviceId
        ? rows.map((row) => row.dependencyServiceId)
        : service.dependencies.map((dependency) => dependency.dependencyServiceId)
    ])
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependencyId of edges.get(id) ?? []) {
      if (visit(dependencyId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (services.some((service) => visit(service.id))) {
    return { error: "Service dependencies must not contain a cycle" };
  }
  return { rows };
}

function serializeLog(row: {
  id: bigint;
  projectId: string;
  serviceId: string;
  releaseId: string;
  serviceDeploymentId: string;
  stream: string;
  level: string;
  message: string;
  containerId: string | null;
  containerTimestamp: Date | null;
  restartNumber: number;
  createdAt: Date;
}) {
  return { ...row, id: row.id.toString() };
}

async function removeProjectDocker(projectId: string): Promise<void> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`sohwe.project=${projectId}`] }
  });
  for (const item of containers) {
    const container = docker.getContainer(item.Id);
    await container.stop({ t: 10 }).catch(() => {});
    await container.remove().catch(() => {});
  }
  try {
    await docker.getNetwork(projectInternalNetworkName(projectId)).remove();
  } catch (error) {
    const status =
      error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode)
        : undefined;
    if (status !== 404) throw error;
  }
}

export async function registerProjectRoutes(app: FastifyInstance) {
  let deployQueue: ReturnType<typeof createProjectDeployQueue> | null = null;
  const queue = () => (deployQueue ??= createProjectDeployQueue());
  app.addHook("onClose", async () => {
    await deployQueue?.close().catch(() => {});
  });

  app.post(
    "/api/projects",
    {
      preHandler: [requireRole("admin")],
      schema: { body: CreateProjectSchema },
      logLevel: "silent"
    },
    async (req, reply) => {
      const user = req.user!;
      const body = CreateProjectSchema.parse(req.body);
      const ref = parseGitHubRepoUrl(body.gitRepo);
      const fullName = ref ? repoFullName(ref) : null;
      if (body.autoDeploy) {
        const blocker = await autoDeployBlocker(user.organizationId, fullName);
        if (blocker) return reply.badRequest(blocker);
      }
      const requestedDomains = body.services.flatMap((service) => service.domains);
      if (new Set(requestedDomains).size !== requestedDomains.length) {
        return reply.conflict("A domain can belong to only one HTTP service");
      }
      if (requestedDomains.length > 0) {
        const [appDomain, serviceDomain] = await Promise.all([
          prisma.domain.findFirst({
            where: { hostname: { in: requestedDomains } },
            select: { hostname: true }
          }),
          prisma.serviceDomain.findFirst({
            where: { hostname: { in: requestedDomains } },
            select: { hostname: true }
          })
        ]);
        const taken = appDomain?.hostname ?? serviceDomain?.hostname;
        if (taken) return reply.conflict(`${taken} is already in use`);
      }

      try {
        const row = await prisma.$transaction(async (tx) => {
          const createdProject = await tx.project.create({
            data: {
              organizationId: user.organizationId,
              name: body.name,
              slug: body.slug,
              gitRepo: body.gitRepo,
              gitBranch: body.gitBranch,
              repoFullName: fullName,
              autoDeploy: body.autoDeploy,
              envVarsEncrypted:
                Object.keys(body.envVars).length > 0
                  ? encryptJson(body.envVars)
                  : null
            },
            select: { id: true }
          });
          const serviceIds = new Map<string, string>();
          for (const service of body.services) {
            const createdService = await tx.service.create({
              data: {
                projectId: createdProject.id,
                name: service.name,
                slug: service.slug,
                kind: service.kind,
                buildMode: service.buildMode,
                buildCmd: service.buildCmd ?? null,
                startCmd: service.startCmd ?? null,
                runtimeCmd: service.runtimeCmd ?? null,
                serviceDirectory: service.serviceDirectory,
                workspaceSelector: service.workspaceSelector ?? null,
                dockerfilePath: service.dockerfilePath,
                dockerTarget: service.dockerTarget ?? null,
                imageGroup: service.imageGroup ?? null,
                port: service.kind === "http" ? service.port : null,
                memoryLimitMb: service.memoryLimitMb ?? null,
                cpuLimit: service.cpuLimit ?? null,
                restartPolicy:
                  service.kind === "release" ? "no" : service.restartPolicy,
                healthCheckCmd: service.healthCheckCmd ?? null,
                healthCheckIntervalSeconds: service.healthCheckIntervalSeconds,
                healthCheckTimeoutSeconds: service.healthCheckTimeoutSeconds,
                healthCheckRetries: service.healthCheckRetries,
                healthCheckStartPeriodSeconds:
                  service.healthCheckStartPeriodSeconds,
                envVarsEncrypted:
                  Object.keys(service.envVars).length > 0
                    ? encryptJson(service.envVars)
                    : null,
                buildArgsEncrypted:
                  Object.keys(service.buildArgs).length > 0
                    ? encryptJson(service.buildArgs)
                    : null,
                domains: {
                  create: service.domains.map((hostname, index) => ({
                    hostname,
                    isPrimary: index === 0
                  }))
                }
              },
              select: { id: true }
            });
            serviceIds.set(service.slug, createdService.id);
          }
          const dependencies = body.services.flatMap((service) =>
            service.dependsOn.map((dependency) => ({
              serviceId: serviceIds.get(service.slug)!,
              dependencyServiceId: serviceIds.get(dependency.serviceSlug)!,
              condition: dependency.condition
            }))
          );
          if (dependencies.length > 0) {
            await tx.serviceDependency.createMany({ data: dependencies });
          }
          return tx.project.findUniqueOrThrow({
            where: { id: createdProject.id },
            select: projectSelect()
          });
        });
        await recordAudit(req, {
          action: "project.create",
          targetType: "project",
          targetId: row.id,
          targetLabel: row.slug,
          metadata: {
            gitRepo: body.gitRepo,
            gitBranch: body.gitBranch,
            services: body.services.map((service) => ({
              slug: service.slug,
              kind: service.kind,
              variableKeys: Object.keys(service.envVars).sort(),
              buildArgKeys: Object.keys(service.buildArgs).sort()
            })),
            variableKeys: Object.keys(body.envVars).sort()
          }
        });
        return row;
      } catch (error) {
        if (isUniqueViolation(error, "slug")) {
          return reply.conflict(`A project with slug "${body.slug}" already exists`);
        }
        if (isUniqueViolation(error, "hostname")) {
          return reply.conflict("One of these domains is already in use");
        }
        throw error;
      }
    }
  );

  app.get(
    "/api/projects",
    { preHandler: [requireRole("member")] },
    async (req) =>
      prisma.project.findMany({
        where: { organizationId: req.user!.organizationId },
        orderBy: { createdAt: "desc" },
        select: projectSelect(5)
      })
  );

  app.get(
    "/api/projects/:id",
    { preHandler: [requireRole("member")], schema: { params: IdParam } },
    async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const row = await prisma.project.findFirst({
        where: { id, organizationId: req.user!.organizationId },
        select: projectSelect(30)
      });
      return row ?? reply.notFound();
    }
  );

  app.patch(
    "/api/projects/:id",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: UpdateProjectSchema }
    },
    async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = UpdateProjectSchema.parse(req.body);
      const project = await prisma.project.findFirst({
        where: { id, organizationId: req.user!.organizationId },
        select: {
          id: true,
          slug: true,
          gitRepo: true,
          repoFullName: true,
          autoDeploy: true,
          releases: {
            where: { status: { in: ["pending", "building", "releasing", "deploying"] } },
            select: { id: true }
          }
        }
      });
      if (!project) return reply.notFound();
      if (project.releases.length > 0) {
        return reply.conflict("Project settings cannot change while a release is in progress");
      }

      const gitRepo = body.gitRepo ?? project.gitRepo;
      const ref = parseGitHubRepoUrl(gitRepo);
      const fullName = ref ? repoFullName(ref) : null;
      if (body.autoDeploy ?? project.autoDeploy) {
        const blocker = await autoDeployBlocker(req.user!.organizationId, fullName);
        if (blocker) return reply.badRequest(blocker);
      }

      const row = await prisma.project.update({
        where: { id: project.id },
        data: {
          ...body,
          ...(body.gitRepo !== undefined ? { repoFullName: fullName } : {})
        },
        select: projectSelect()
      });
      await recordAudit(req, {
        action: "project.update",
        targetType: "project",
        targetId: project.id,
        targetLabel: project.slug,
        metadata: { fields: Object.keys(body).sort() }
      });
      return row;
    }
  );

  app.patch(
    "/api/services/:serviceId",
    {
      preHandler: [requireRole("admin")],
      schema: { params: ServiceParam, body: UpdateServiceSchema }
    },
    async (req, reply) => {
      const { serviceId } = ServiceParam.parse(req.params);
      const body = UpdateServiceSchema.parse(req.body);
      const service = await prisma.service.findFirst({
        where: {
          id: serviceId,
          project: { organizationId: req.user!.organizationId }
        },
        include: {
          project: {
            select: {
              slug: true,
              services: {
                select: {
                  id: true,
                  slug: true,
                  kind: true,
                  dependencies: { select: { dependencyServiceId: true } }
                }
              },
              releases: {
                where: { status: { in: ["pending", "building", "releasing", "deploying"] } },
                select: { id: true }
              }
            }
          }
        }
      });
      if (!service) return reply.notFound();
      if (service.project.releases.length > 0) {
        return reply.conflict("Service settings cannot change while a release is in progress");
      }
      if (service.kind === "http" && body.port === null) {
        return reply.badRequest("HTTP services require a port");
      }
      if (service.kind === "release" && body.restartPolicy && body.restartPolicy !== "no") {
        return reply.badRequest("Release services cannot restart");
      }
      const dependencyChange = body.dependsOn
        ? validateDependencyChange(
            service.project.services,
            service.id,
            body.dependsOn
          )
        : null;
      if (dependencyChange?.error) return reply.badRequest(dependencyChange.error);
      const { dependsOn: _dependsOn, ...servicePatch } = body;
      const data = Object.fromEntries(
        Object.entries(servicePatch).map(([key, value]) => [key, value === "" ? null : value])
      );
      const updated = await prisma.$transaction(async (tx) => {
        if (dependencyChange?.rows) {
          await tx.serviceDependency.deleteMany({ where: { serviceId: service.id } });
          if (dependencyChange.rows.length > 0) {
            await tx.serviceDependency.createMany({
              data: dependencyChange.rows.map((dependency) => ({
                serviceId: service.id,
                ...dependency
              }))
            });
          }
        }
        return tx.service.update({
          where: { id: service.id },
          data,
          select: serviceSelect
        });
      });
      await recordAudit(req, {
        action: "service.update",
        targetType: "service",
        targetId: service.id,
        targetLabel: `${service.project.slug}/${service.slug}`,
        metadata: { fields: Object.keys(body).sort() }
      });
      return updated;
    }
  );

  app.put(
    "/api/services/:serviceId/domains",
    {
      preHandler: [requireRole("admin")],
      schema: { params: ServiceParam, body: ServiceDomainsReplaceSchema }
    },
    async (req, reply) => {
      const { serviceId } = ServiceParam.parse(req.params);
      const { domains } = ServiceDomainsReplaceSchema.parse(req.body);
      if (new Set(domains).size !== domains.length) {
        return reply.conflict("A domain may be listed only once");
      }
      const service = await prisma.service.findFirst({
        where: {
          id: serviceId,
          project: { organizationId: req.user!.organizationId }
        },
        select: {
          id: true,
          slug: true,
          kind: true,
          project: {
            select: {
              slug: true,
              releases: {
                where: { status: { in: ["pending", "building", "releasing", "deploying"] } },
                select: { id: true }
              }
            }
          }
        }
      });
      if (!service) return reply.notFound();
      if (service.kind !== "http" && domains.length > 0) {
        return reply.badRequest("Only HTTP services may have domains");
      }
      if (service.project.releases.length > 0) {
        return reply.conflict("Service domains cannot change while a release is in progress");
      }
      if (domains.length > 0) {
        const [appOwner, serviceOwner] = await Promise.all([
          prisma.domain.findFirst({
            where: { hostname: { in: domains } },
            select: { hostname: true }
          }),
          prisma.serviceDomain.findFirst({
            where: { hostname: { in: domains }, serviceId: { not: service.id } },
            select: { hostname: true }
          })
        ]);
        const taken = appOwner?.hostname ?? serviceOwner?.hostname;
        if (taken) return reply.conflict(`${taken} is already in use`);
      }
      await prisma.$transaction(async (tx) => {
        await tx.serviceDomain.deleteMany({ where: { serviceId: service.id } });
        if (domains.length > 0) {
          await tx.serviceDomain.createMany({
            data: domains.map((hostname, index) => ({
              serviceId: service.id,
              hostname,
              isPrimary: index === 0
            }))
          });
        }
      });
      await recordAudit(req, {
        action: "service.update",
        targetType: "service",
        targetId: service.id,
        targetLabel: `${service.project.slug}/${service.slug}`,
        metadata: { domains }
      });
      return prisma.service.findUniqueOrThrow({
        where: { id: service.id },
        select: serviceSelect
      });
    }
  );

  app.post(
    "/api/projects/:id/services",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: CreateServiceSchema },
      logLevel: "silent"
    },
    async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const body = CreateServiceSchema.parse(req.body);
      const project = await prisma.project.findFirst({
        where: { id, organizationId: req.user!.organizationId },
        include: {
          services: {
            select: {
              id: true,
              slug: true,
              kind: true,
              dependencies: { select: { dependencyServiceId: true } }
            }
          },
          releases: {
            where: { status: { in: ["pending", "building", "releasing", "deploying"] } },
            select: { id: true }
          }
        }
      });
      if (!project) return reply.notFound();
      if (project.releases.length > 0) {
        return reply.conflict("Services cannot change while a release is in progress");
      }
      if (
        body.kind === "release" &&
        project.services.some((service) => service.kind === "release")
      ) {
        return reply.conflict("A project may have only one release service");
      }
      const dependencyRows: { dependencyServiceId: string; condition: string }[] = [];
      for (const dependency of body.dependsOn) {
        const target = project.services.find(
          (service) => service.slug === dependency.serviceSlug
        );
        if (!target) {
          return reply.badRequest(`Unknown service dependency: ${dependency.serviceSlug}`);
        }
        if (target.kind === "release") {
          return reply.badRequest(
            "Runtime services cannot depend on a one-shot release service"
          );
        }
        dependencyRows.push({
          dependencyServiceId: target.id,
          condition: dependency.condition
        });
      }
      for (const hostname of body.domains) {
        const [appOwner, projectOwner] = await Promise.all([
          prisma.domain.findUnique({ where: { hostname }, select: { id: true } }),
          prisma.serviceDomain.findUnique({ where: { hostname }, select: { id: true } })
        ]);
        if (appOwner || projectOwner) return reply.conflict(`${hostname} is already in use`);
      }
      try {
        const service = await prisma.$transaction(async (tx) => {
          const created = await tx.service.create({
            data: {
              projectId: project.id,
              name: body.name,
              slug: body.slug,
              kind: body.kind,
              buildMode: body.buildMode,
              buildCmd: body.buildCmd ?? null,
              startCmd: body.startCmd ?? null,
              runtimeCmd: body.runtimeCmd ?? null,
              serviceDirectory: body.serviceDirectory,
              workspaceSelector: body.workspaceSelector ?? null,
              dockerfilePath: body.dockerfilePath,
              dockerTarget: body.dockerTarget ?? null,
              imageGroup: body.imageGroup ?? null,
              port: body.kind === "http" ? body.port : null,
              memoryLimitMb: body.memoryLimitMb ?? null,
              cpuLimit: body.cpuLimit ?? null,
              restartPolicy: body.kind === "release" ? "no" : body.restartPolicy,
              healthCheckCmd: body.healthCheckCmd ?? null,
              healthCheckIntervalSeconds: body.healthCheckIntervalSeconds,
              healthCheckTimeoutSeconds: body.healthCheckTimeoutSeconds,
              healthCheckRetries: body.healthCheckRetries,
              healthCheckStartPeriodSeconds:
                body.healthCheckStartPeriodSeconds,
              envVarsEncrypted:
                Object.keys(body.envVars).length > 0
                  ? encryptJson(body.envVars)
                  : null,
              buildArgsEncrypted:
                Object.keys(body.buildArgs).length > 0
                  ? encryptJson(body.buildArgs)
                  : null,
              domains: {
                create: body.domains.map((hostname, index) => ({
                  hostname,
                  isPrimary: index === 0
                }))
              }
            },
            select: { id: true }
          });
          if (dependencyRows.length > 0) {
            await tx.serviceDependency.createMany({
              data: dependencyRows.map((dependency) => ({
                serviceId: created.id,
                ...dependency
              }))
            });
          }
          return tx.service.findUniqueOrThrow({
            where: { id: created.id },
            select: serviceSelect
          });
        });
        await recordAudit(req, {
          action: "service.create",
          targetType: "service",
          targetId: service.id,
          targetLabel: `${project.slug}/${service.slug}`,
          metadata: {
            projectId: project.id,
            kind: service.kind,
            variableKeys: Object.keys(body.envVars).sort(),
            buildArgKeys: Object.keys(body.buildArgs).sort()
          }
        });
        return reply.status(201).send(service);
      } catch (error) {
        if (isUniqueViolation(error, "slug")) {
          return reply.conflict(`Service slug "${body.slug}" is already in use`);
        }
        throw error;
      }
    }
  );

  app.delete(
    "/api/services/:serviceId",
    { preHandler: [requireRole("admin")], schema: { params: ServiceParam } },
    async (req, reply) => {
      const { serviceId } = ServiceParam.parse(req.params);
      const service = await prisma.service.findFirst({
        where: {
          id: serviceId,
          project: { organizationId: req.user!.organizationId }
        },
        include: {
          dependents: {
            select: { service: { select: { slug: true } } }
          },
          project: {
            select: {
              id: true,
              slug: true,
              _count: { select: { services: true } },
              releases: {
                where: {
                  status: { in: ["pending", "building", "releasing", "deploying"] }
                },
                select: { id: true }
              }
            }
          }
        }
      });
      if (!service) return reply.notFound();
      if (service.project._count.services <= 1) {
        return reply.badRequest("A project must keep at least one service");
      }
      if (service.project.releases.length > 0) {
        return reply.conflict("Services cannot change while a release is in progress");
      }
      if (service.dependents.length > 0) {
        return reply.conflict(
          `Remove dependencies from ${service.dependents
            .map((dependency) => dependency.service.slug)
            .join(", ")} before deleting this service`
        );
      }
      await prisma.service.delete({ where: { id: service.id } });
      await recordAudit(req, {
        action: "service.delete",
        targetType: "service",
        targetId: service.id,
        targetLabel: `${service.project.slug}/${service.slug}`,
        metadata: { projectId: service.project.id, kind: service.kind }
      });
      return { ok: true };
    }
  );

  // Shared project variables and service overrides are encrypted independently.
  // Values never appear in responses, request logs, or audit metadata.
  app.put(
    "/api/projects/:id/variables",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: EnvVarsReplaceSchema },
      logLevel: "silent"
    },
    async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { vars } = EnvVarsReplaceSchema.parse(req.body);
      const project = await prisma.project.findFirst({
        where: { id, organizationId: req.user!.organizationId },
        select: { id: true, slug: true }
      });
      if (!project) return reply.notFound();
      await prisma.project.update({
        where: { id },
        data: {
          envVarsEncrypted:
            Object.keys(vars).length > 0 ? encryptJson(vars) : null
        }
      });
      await recordAudit(req, {
        action: "project.variables.update",
        targetType: "project",
        targetId: id,
        targetLabel: project.slug,
        metadata: { keys: Object.keys(vars).sort(), count: Object.keys(vars).length }
      });
      return { keys: Object.keys(vars).sort() };
    }
  );

  app.patch(
    "/api/projects/:id/variables",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: EnvVarsPatchSchema },
      logLevel: "silent"
    },
    async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { set, unset } = EnvVarsPatchSchema.parse(req.body);
      if ((!set || Object.keys(set).length === 0) && (!unset || unset.length === 0)) {
        return reply.badRequest("Provide set and/or unset");
      }
      const project = await prisma.project.findFirst({
        where: { id, organizationId: req.user!.organizationId },
        select: { id: true, slug: true, envVarsEncrypted: true }
      });
      if (!project) return reply.notFound();
      let before: Record<string, string>;
      try {
        before = readVarBlob(project.envVarsEncrypted);
      } catch {
        return reply.status(500).send({ message: "Failed to read project variables" });
      }
      const vars = applyVarPatch(before, set, unset);
      await prisma.project.update({
        where: { id: project.id },
        data: { envVarsEncrypted: encodeVarBlob(vars) }
      });
      await recordAudit(req, {
        action: "project.variables.update",
        targetType: "project",
        targetId: project.id,
        targetLabel: project.slug,
        metadata: {
          setKeys: Object.keys(set ?? {}).sort(),
          unsetKeys: [...(unset ?? [])].sort()
        }
      });
      return { keys: Object.keys(vars).sort() };
    }
  );

  app.put(
    "/api/services/:serviceId/variables",
    {
      preHandler: [requireRole("admin")],
      schema: { params: ServiceParam, body: EnvVarsReplaceSchema },
      logLevel: "silent"
    },
    async (req, reply) => {
      const { serviceId } = ServiceParam.parse(req.params);
      const { vars } = EnvVarsReplaceSchema.parse(req.body);
      const service = await prisma.service.findFirst({
        where: {
          id: serviceId,
          project: { organizationId: req.user!.organizationId }
        },
        select: { id: true, slug: true, project: { select: { slug: true } } }
      });
      if (!service) return reply.notFound();
      await prisma.service.update({
        where: { id: service.id },
        data: {
          envVarsEncrypted:
            Object.keys(vars).length > 0 ? encryptJson(vars) : null
        }
      });
      await recordAudit(req, {
        action: "service.variables.update",
        targetType: "service",
        targetId: service.id,
        targetLabel: `${service.project.slug}/${service.slug}`,
        metadata: { keys: Object.keys(vars).sort(), count: Object.keys(vars).length }
      });
      return { keys: Object.keys(vars).sort() };
    }
  );

  app.patch(
    "/api/services/:serviceId/variables",
    {
      preHandler: [requireRole("admin")],
      schema: { params: ServiceParam, body: EnvVarsPatchSchema },
      logLevel: "silent"
    },
    async (req, reply) => {
      const { serviceId } = ServiceParam.parse(req.params);
      const { set, unset } = EnvVarsPatchSchema.parse(req.body);
      if ((!set || Object.keys(set).length === 0) && (!unset || unset.length === 0)) {
        return reply.badRequest("Provide set and/or unset");
      }
      const service = await prisma.service.findFirst({
        where: {
          id: serviceId,
          project: { organizationId: req.user!.organizationId }
        },
        select: {
          id: true,
          slug: true,
          envVarsEncrypted: true,
          project: { select: { slug: true } }
        }
      });
      if (!service) return reply.notFound();
      let before: Record<string, string>;
      try {
        before = readVarBlob(service.envVarsEncrypted);
      } catch {
        return reply.status(500).send({ message: "Failed to read service variables" });
      }
      const vars = applyVarPatch(before, set, unset);
      await prisma.service.update({
        where: { id: service.id },
        data: { envVarsEncrypted: encodeVarBlob(vars) }
      });
      await recordAudit(req, {
        action: "service.variables.update",
        targetType: "service",
        targetId: service.id,
        targetLabel: `${service.project.slug}/${service.slug}`,
        metadata: {
          setKeys: Object.keys(set ?? {}).sort(),
          unsetKeys: [...(unset ?? [])].sort()
        }
      });
      return { keys: Object.keys(vars).sort() };
    }
  );

  app.put(
    "/api/services/:serviceId/build-args",
    {
      preHandler: [requireRole("admin")],
      schema: { params: ServiceParam, body: EnvVarsReplaceSchema },
      logLevel: "silent"
    },
    async (req, reply) => {
      const { serviceId } = ServiceParam.parse(req.params);
      const { vars } = EnvVarsReplaceSchema.parse(req.body);
      const service = await prisma.service.findFirst({
        where: {
          id: serviceId,
          project: { organizationId: req.user!.organizationId }
        },
        select: { id: true, slug: true, project: { select: { slug: true } } }
      });
      if (!service) return reply.notFound();
      await prisma.service.update({
        where: { id: service.id },
        data: {
          buildArgsEncrypted:
            Object.keys(vars).length > 0 ? encryptJson(vars) : null
        }
      });
      await recordAudit(req, {
        action: "build_args.update",
        targetType: "build_args",
        targetId: service.id,
        targetLabel: `${service.project.slug}/${service.slug}`,
        metadata: {
          serviceId: service.id,
          keys: Object.keys(vars).sort(),
          count: Object.keys(vars).length
        }
      });
      return { keys: Object.keys(vars).sort() };
    }
  );

  app.patch(
    "/api/services/:serviceId/build-args",
    {
      preHandler: [requireRole("admin")],
      schema: { params: ServiceParam, body: BuildArgsPatchSchema },
      logLevel: "silent"
    },
    async (req, reply) => {
      const { serviceId } = ServiceParam.parse(req.params);
      const { set, unset } = BuildArgsPatchSchema.parse(req.body);
      if ((!set || Object.keys(set).length === 0) && (!unset || unset.length === 0)) {
        return reply.badRequest("Provide set and/or unset");
      }
      const service = await prisma.service.findFirst({
        where: {
          id: serviceId,
          project: { organizationId: req.user!.organizationId }
        },
        select: {
          id: true,
          slug: true,
          buildArgsEncrypted: true,
          project: { select: { slug: true } }
        }
      });
      if (!service) return reply.notFound();
      let before: Record<string, string>;
      try {
        before = readVarBlob(service.buildArgsEncrypted);
      } catch {
        return reply.status(500).send({ message: "Failed to read service build arguments" });
      }
      const vars = applyVarPatch(before, set, unset);
      await prisma.service.update({
        where: { id: service.id },
        data: { buildArgsEncrypted: encodeVarBlob(vars) }
      });
      await recordAudit(req, {
        action: "build_args.update",
        targetType: "service",
        targetId: service.id,
        targetLabel: `${service.project.slug}/${service.slug}`,
        metadata: {
          setKeys: Object.keys(set ?? {}).sort(),
          unsetKeys: [...(unset ?? [])].sort()
        }
      });
      return { keys: Object.keys(vars).sort() };
    }
  );

  app.delete(
    "/api/projects/:id",
    { preHandler: [requireRole("admin")], schema: { params: IdParam } },
    async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const project = await prisma.project.findFirst({
        where: { id, organizationId: req.user!.organizationId },
        select: { id: true, slug: true }
      });
      if (!project) return reply.notFound();
      await removeProjectDocker(id);
      await prisma.project.delete({ where: { id } });
      await recordAudit(req, {
        action: "project.delete",
        targetType: "project",
        targetId: id,
        targetLabel: project.slug
      });
      return { ok: true };
    }
  );

  async function enqueueRelease(input: {
    projectId: string;
    organizationId: string;
    trigger: "manual" | "rollback";
    sourceReleaseId?: string;
  }) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, organizationId: input.organizationId },
      include: { services: { select: { id: true } } }
    });
    if (!project) return null;
    const active = await prisma.projectRelease.findFirst({
      where: {
        projectId: project.id,
        status: { in: ["pending", "building", "releasing", "deploying"] }
      },
      select: { id: true }
    });
    if (active) return { conflict: active.id } as const;
    const release = await prisma.projectRelease.create({
      data: {
        projectId: project.id,
        trigger: input.trigger,
        sourceReleaseId: input.sourceReleaseId ?? null,
        serviceDeployments: {
          create: project.services.map((service) => ({ serviceId: service.id }))
        }
      }
    });
    await queue().add(
      input.trigger === "rollback" ? "project-promote" : "project-deploy",
      {
        projectId: project.id,
        releaseId: release.id,
        promoteFromReleaseId: input.sourceReleaseId
      },
      { jobId: release.id, removeOnComplete: 200, removeOnFail: 100 }
    );
    return { release, project } as const;
  }

  app.post(
    "/api/projects/:id/deploy",
    { preHandler: [requireRole("member")], schema: { params: IdParam } },
    async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const result = await enqueueRelease({
        projectId: id,
        organizationId: req.user!.organizationId,
        trigger: "manual"
      });
      if (!result) return reply.notFound();
      if ("conflict" in result) {
        return reply.conflict(`Release ${result.conflict} is already in progress`);
      }
      await recordAudit(req, {
        action: "project.release",
        targetType: "projectRelease",
        targetId: result.release.id,
        targetLabel: result.project.slug,
        metadata: { projectId: result.project.id, branch: result.project.gitBranch }
      });
      return reply.status(202).send({
        release: { id: result.release.id, status: result.release.status }
      });
    }
  );

  app.post(
    "/api/projects/:id/rollback",
    {
      preHandler: [requireRole("member")],
      schema: { params: IdParam, body: ProjectRollbackBodySchema }
    },
    async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const { sourceReleaseId } = ProjectRollbackBodySchema.parse(req.body);
      const source = await prisma.projectRelease.findFirst({
        where: {
          id: sourceReleaseId,
          projectId: id,
          project: { organizationId: req.user!.organizationId },
          status: "success"
        },
        select: { id: true }
      });
      if (!source) return reply.badRequest("Source release is not successful");
      const result = await enqueueRelease({
        projectId: id,
        organizationId: req.user!.organizationId,
        trigger: "rollback",
        sourceReleaseId
      });
      if (!result) return reply.notFound();
      if ("conflict" in result) return reply.conflict("A release is already in progress");
      await recordAudit(req, {
        action: "project.rollback",
        targetType: "projectRelease",
        targetId: result.release.id,
        targetLabel: result.project.slug,
        metadata: { projectId: id, sourceReleaseId, migrationsAreForwardOnly: true }
      });
      return reply.status(202).send({
        release: { id: result.release.id, status: result.release.status },
        warning: "Database migrations are forward-only and are not reversed"
      });
    }
  );

  app.get(
    "/api/project-releases/:releaseId",
    { preHandler: [requireRole("member")], schema: { params: ReleaseParam } },
    async (req, reply) => {
      const { releaseId } = ReleaseParam.parse(req.params);
      const row = await prisma.projectRelease.findFirst({
        where: {
          id: releaseId,
          project: { organizationId: req.user!.organizationId }
        },
        select: {
          ...releaseSelect,
          serviceDeployments: {
            ...releaseSelect.serviceDeployments,
            select: {
              ...releaseSelect.serviceDeployments.select,
              buildLogs: true
            }
          }
        }
      });
      return row ?? reply.notFound();
    }
  );

  app.get(
    "/api/projects/:id/log-history",
    {
      preHandler: [requireRole("member")],
      schema: { params: IdParam, querystring: ServiceLogsQuerySchema }
    },
    async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const query = ServiceLogsQuerySchema.parse(req.query);
      const project = await prisma.project.findFirst({
        where: { id, organizationId: req.user!.organizationId },
        select: { id: true }
      });
      if (!project) return reply.notFound();
      const rows = await prisma.serviceLog.findMany({
        where: {
          projectId: id,
          serviceId: query.serviceId,
          releaseId: query.releaseId,
          stream: query.stream,
          level: query.level,
          id: {
            gt: query.after,
            lt: query.before
          }
        },
        orderBy: { id: query.before ? "desc" : "asc" },
        take: query.limit
      });
      if (query.before) rows.reverse();
      return { logs: rows.map(serializeLog), hasMore: rows.length === query.limit };
    }
  );

  app.get(
    "/api/projects/:id/logs",
    {
      preHandler: [requireRole("member")],
      schema: { params: IdParam, querystring: ServiceLogsQuerySchema }
    },
    async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const query = ServiceLogsQuerySchema.parse(req.query);
      const project = await prisma.project.findFirst({
        where: { id, organizationId: req.user!.organizationId },
        select: { id: true }
      });
      if (!project) return reply.notFound();
      const sub = new IORedis(getRedisUrl());
      reply.hijack();
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.flushHeaders?.();
      let replayReady = false;
      const buffered: string[] = [];
      const seen = new Set<string>();
      const onMessage = (_channel: string, raw: string) => {
        try {
          const event = JSON.parse(raw) as {
            id?: string;
            serviceId?: string;
            releaseId?: string;
            stream?: string;
            level?: string;
          };
          if (query.serviceId && event.serviceId !== query.serviceId) return;
          if (query.releaseId && event.releaseId !== query.releaseId) return;
          if (query.stream && event.stream !== query.stream) return;
          if (query.level && event.level !== query.level) return;
          if (event.id && seen.has(event.id)) return;
          if (event.id && query.after !== undefined && BigInt(event.id) <= query.after) {
            return;
          }
          if (!replayReady) {
            buffered.push(raw);
            return;
          }
          if (event.id) seen.add(event.id);
          reply.raw.write(`data: ${raw}\n\n`);
        } catch {
          // Ignore malformed pub/sub events; persisted replay remains sound.
        }
      };
      sub.on("message", onMessage);
      req.raw.on("close", () => {
        sub.off("message", onMessage);
        void sub.quit().catch(() => {});
      });
      // Subscribe before reading history. Any event committed between those
      // operations is buffered, then deduplicated by its persisted cursor.
      await sub.subscribe(projectLogChannelName(id));
      const replay = await prisma.serviceLog.findMany({
        where: {
          projectId: id,
          serviceId: query.serviceId,
          releaseId: query.releaseId,
          stream: query.stream,
          level: query.level,
          id: query.after === undefined ? undefined : { gt: query.after }
        },
        orderBy: { id: "desc" },
        take: query.limit
      });
      replay.reverse();
      for (const row of replay) seen.add(row.id.toString());
      reply.raw.write(
        `data: ${JSON.stringify({ type: "replay", logs: replay.map(serializeLog) })}\n\n`
      );
      replayReady = true;
      for (const raw of buffered) onMessage(projectLogChannelName(id), raw);
    }
  );
}
