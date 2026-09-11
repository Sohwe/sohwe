import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buildAppImage, type BuildMode } from "@sohwe/builder";
import { decryptJson, toDockerEnvList } from "@sohwe/crypto";
import { prisma } from "@sohwe/db";
import {
  projectLogChannelName,
  serviceLogChannelName,
  type ProjectDeployJobData
} from "@sohwe/queue";
import {
  buildDatastoreConnectionUrl,
  datastoreContainerName,
  datastoreServicePort,
  projectInternalNetworkName,
  type DatastoreCredentials,
  type DatastoreKind
} from "@sohwe/types";
import type Docker from "dockerode";
import { LogSink } from "./build-log";
import { resolveRoutingConfig } from "./container-spec";
import {
  connectHttpServiceToRoutingNetwork,
  ensureProjectNetwork,
  stopAndRemoveProjectContainers
} from "./project-docker-ops";
import {
  buildProjectServiceContainerSpec,
  type ProjectServiceSpec
} from "./project-container-spec";
import { createServiceLogManager, type ServiceLogEvent } from "./service-logs";
import {
  redactDeployError,
  resolveGitHubContext,
  type GitHubDeployContext
} from "./github";

const MAX_COMMIT_MESSAGE = 2000;
const MAX_PERSISTED_LOGS_PER_PROJECT = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Honor image HEALTHCHECK when present; otherwise require short process stability. */
async function waitForCandidateReady(
  container: Docker.Container,
  service: {
    slug: string;
    healthCheckCmd: string | null;
    healthCheckIntervalSeconds: number;
    healthCheckTimeoutSeconds: number;
    healthCheckRetries: number;
    healthCheckStartPeriodSeconds: number;
  }
): Promise<void> {
  const stabilityMs = Math.max(0, service.healthCheckStartPeriodSeconds) * 1_000;
  const healthBudgetMs = service.healthCheckCmd
    ? stabilityMs +
      service.healthCheckIntervalSeconds * service.healthCheckRetries * 1_000 +
      service.healthCheckTimeoutSeconds * 1_000 +
      5_000
    : Math.max(30_000, stabilityMs + 5_000);
  const deadline = Date.now() + healthBudgetMs;
  let observedWithoutHealthAt: number | null = null;
  for (;;) {
    const info = await container.inspect();
    if (!info.State?.Running) {
      throw new Error(`Service ${service.slug} stopped before it became ready`);
    }
    const health = info.State.Health?.Status;
    if (health === "healthy") return;
    if (health === "unhealthy") {
      throw new Error(`Service ${service.slug} failed its container health check`);
    }
    if (!health) {
      observedWithoutHealthAt ??= Date.now();
      if (Date.now() - observedWithoutHealthAt >= stabilityMs) return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Service ${service.slug} did not become ready within ${Math.ceil(healthBudgetMs / 1_000)}s`
      );
    }
    await delay(500);
  }
}

type OrderedService = {
  id: string;
  slug: string;
  kind: string;
  dependencies: {
    condition: string;
    dependencyService: { id: string; slug: string; kind: string };
  }[];
};

/** Stable topological order; persisted order breaks ties for predictable starts. */
export function orderRuntimeServices<T extends OrderedService>(services: T[]): T[] {
  const runtime = services.filter((service) => service.kind !== "release");
  const byId = new Map(runtime.map((service) => [service.id, service]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: T[] = [];
  const visit = (service: T) => {
    if (visited.has(service.id)) return;
    if (visiting.has(service.id)) {
      throw new Error(`Service dependency cycle includes ${service.slug}`);
    }
    visiting.add(service.id);
    for (const dependency of service.dependencies) {
      const target = byId.get(dependency.dependencyService.id);
      if (!target) {
        throw new Error(
          `Service ${service.slug} depends on unavailable service ${dependency.dependencyService.slug}`
        );
      }
      visit(target);
    }
    visiting.delete(service.id);
    visited.add(service.id);
    ordered.push(service);
  };
  runtime.forEach(visit);
  return ordered;
}

function readVars(value: Buffer | Uint8Array | null | undefined): Record<string, string> {
  if (!value?.length) return {};
  return decryptJson(Buffer.isBuffer(value) ? value : Buffer.from(value));
}

function command(
  name: string,
  args: string[],
  cwd: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(name, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (part) => (stdout += part.toString()));
    child.stderr.on("data", (part) => (stderr += part.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${name} failed (${String(code)}): ${stderr || "no stderr"}`));
    });
  });
}

function imageTag(projectSlug: string, releaseId: string, buildKey: string): string {
  const digest = createHash("sha256").update(buildKey).digest("hex").slice(0, 12);
  return `sohwe/project-${projectSlug}:rel-${releaseId.slice(0, 8)}-${digest}`.toLowerCase();
}

function serviceBuildKey(service: {
  imageGroup: string | null;
  buildMode: string;
  buildCmd: string | null;
  startCmd: string | null;
  dockerfilePath: string;
  dockerTarget: string | null;
  buildArgsEncrypted: Buffer | Uint8Array | null;
}): string {
  if (service.imageGroup) return `group:${service.imageGroup}`;
  return JSON.stringify({
    mode: service.buildMode,
    buildCmd: service.buildCmd,
    startCmd: service.startCmd,
    dockerfilePath: service.dockerfilePath,
    dockerTarget: service.dockerTarget,
    // Equal encrypted blobs are intentionally not compared: AES-GCM nonces
    // differ. Hash the decrypted values without ever placing them in a tag/log.
    buildArgs: createHash("sha256")
      .update(JSON.stringify(readVars(service.buildArgsEncrypted)))
      .digest("hex")
  });
}

type Publish = (channel: string, message: string) => Promise<unknown>;

export function createProjectDeployer(deps: {
  docker: Docker;
  publish: Publish;
}) {
  let persistedSincePrune = 0;
  const serviceLogs = createServiceLogManager({
    demux: (stream, stdout, stderr) => {
      deps.docker.modem.demuxStream(stream, stdout, stderr);
    },
    persist: async (event) => {
      let id: string;
      try {
        const created = await prisma.serviceLog.create({
          data: {
            projectId: event.projectId,
            serviceId: event.serviceId,
            releaseId: event.releaseId,
            serviceDeploymentId: event.serviceDeploymentId,
            stream: event.stream,
            level: event.level,
            message: event.message,
            eventKey: event.eventKey,
            containerId: event.containerId,
            containerTimestamp: event.containerTimestamp,
            containerTimestampRaw: event.containerTimestampRaw,
            restartNumber: event.restartNumber ?? 0
          }
        });
        id = created.id.toString();
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        if (code === "P2002" && event.eventKey) return false;
        throw error;
      }
      persistedSincePrune += 1;
      if (persistedSincePrune >= 200) {
        persistedSincePrune = 0;
        await prisma.$executeRaw`
          DELETE FROM "service_logs"
          WHERE "project_id" = ${event.projectId}
            AND "id" NOT IN (
              SELECT "id" FROM "service_logs"
              WHERE "project_id" = ${event.projectId}
              ORDER BY "id" DESC
              LIMIT ${MAX_PERSISTED_LOGS_PER_PROJECT}
            )
        `;
      }
      return { id };
    },
    publish: async (event) => {
      const json = JSON.stringify({ type: "line", ...event });
      await Promise.all([
        deps.publish(serviceLogChannelName(event.serviceId), json),
        deps.publish(projectLogChannelName(event.projectId), json)
      ]);
    }
  });

  async function systemLog(
    meta: Omit<
      ServiceLogEvent,
      | "stream"
      | "level"
      | "message"
      | "containerTimestamp"
      | "containerTimestampRaw"
      | "eventKey"
    >,
    message: string
  ): Promise<void> {
    const event: ServiceLogEvent = {
      ...meta,
      stream: "system",
      level: "info",
      message,
      containerTimestamp: null,
      containerTimestampRaw: null,
      eventKey: null
    };
    const created = await prisma.serviceLog.create({
      data: {
        projectId: event.projectId,
        serviceId: event.serviceId,
        releaseId: event.releaseId,
        serviceDeploymentId: event.serviceDeploymentId,
        stream: event.stream,
        level: event.level,
        message: event.message,
        containerId: event.containerId,
        restartNumber: event.restartNumber ?? 0
      }
    });
    event.id = created.id.toString();
    const json = JSON.stringify({ type: "line", ...event });
    await Promise.all([
      deps.publish(serviceLogChannelName(event.serviceId), json),
      deps.publish(projectLogChannelName(event.projectId), json)
    ]).catch(() => {});
  }

  async function deploy(data: ProjectDeployJobData): Promise<void> {
    const { projectId, releaseId, promoteFromReleaseId } = data;
    let workDir: string | null = null;
    let github: GitHubDeployContext | null = null;
    const project = await prisma.project.findFirst({
      where: { id: projectId },
      include: {
        services: {
          orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
          include: {
            domains: { orderBy: { createdAt: "asc" } },
            dependencies: {
              orderBy: { createdAt: "asc" },
              include: {
                dependencyService: {
                  select: { id: true, slug: true, kind: true }
                }
              }
            }
          }
        },
        datastoreBindings: { include: { datastore: true } }
      }
    });
    if (!project) throw new Error(`Project ${projectId} not found`);
    const release = await prisma.projectRelease.findFirst({
      where: { id: releaseId, projectId },
      include: { serviceDeployments: true }
    });
    if (!release) throw new Error(`Project release ${releaseId} not found`);

    const deployments = new Map(
      release.serviceDeployments.map((deployment) => [deployment.serviceId, deployment])
    );
    const routing = resolveRoutingConfig();
    let commitSha: string | null = null;
    let commitMessage: string | null = null;

    try {
      await prisma.$transaction([
        prisma.project.update({
          where: { id: project.id },
          data: { status: "deploying" }
        }),
        prisma.projectRelease.update({
          where: { id: release.id },
          data: {
            status: "building",
            startedAt: new Date(),
            errorMessage: null
          }
        })
      ]);

      const builtImages = new Map<string, string>();
      if (promoteFromReleaseId) {
        const source = await prisma.projectRelease.findFirst({
          where: { id: promoteFromReleaseId, projectId, status: "success" },
          include: { serviceDeployments: true }
        });
        if (!source) throw new Error("Source project release is not successful");
        const sourceByService = new Map(
          source.serviceDeployments.map((item) => [item.serviceId, item])
        );
        commitSha = source.commitSha;
        commitMessage = source.commitMessage;
        for (const service of project.services) {
          const target = deployments.get(service.id);
          const previous = sourceByService.get(service.id);
          if (!target || !previous?.imageTag) {
            throw new Error(`Rollback image is missing for service ${service.slug}`);
          }
          await prisma.serviceDeployment.update({
            where: { id: target.id },
            data: {
              imageTag: previous.imageTag,
              status: "built",
              buildLogs: `[sohwe] Reusing ${previous.imageTag} from release ${source.id}\n`
            }
          });
          builtImages.set(serviceBuildKey(service), previous.imageTag);
        }
      } else {
        workDir = await mkdtemp(join(tmpdir(), "sohwe-project-"));
        const repoDir = join(workDir, "repo");
        github = await resolveGitHubContext(project).catch(() => null);
        await command(
          "git",
          ["clone", "--depth", "1", "-b", project.gitBranch, github?.cloneUrl ?? project.gitRepo, repoDir],
          process.cwd()
        );
        commitSha = await command("git", ["rev-parse", "HEAD"], repoDir);
        commitMessage = (
          await command("git", ["log", "-1", "--pretty=format:%s"], repoDir)
        ).slice(0, MAX_COMMIT_MESSAGE);

        // Every image is built before a release job runs or a live container
        // is touched. Explicit image groups reuse the first successful build.
        for (const service of project.services) {
          const deployment = deployments.get(service.id);
          if (!deployment) throw new Error(`Deployment row missing for ${service.slug}`);
          const key = serviceBuildKey(service);
          const reusable = builtImages.get(key);
          if (reusable) {
            await prisma.serviceDeployment.update({
              where: { id: deployment.id },
              data: {
                status: "built",
                imageTag: reusable,
                buildLogs: `[sohwe] Reusing image group ${service.imageGroup ?? key}\n`
              }
            });
            continue;
          }

          await prisma.serviceDeployment.update({
            where: { id: deployment.id },
            data: { status: "building", startedAt: new Date(), buildLogs: "" }
          });
          const sink = new LogSink({
            append: async (addition) => {
              await prisma.$executeRaw`
                UPDATE "service_deployments"
                SET "build_logs" = COALESCE("build_logs", '') || ${addition}
                WHERE "id" = ${deployment.id}
              `;
            },
            replace: async (text) => {
              await prisma.serviceDeployment.update({
                where: { id: deployment.id },
                data: { buildLogs: text }
              });
            }
          });
          const tag = imageTag(project.slug, release.id, key);
          const onLog = (line: string) => sink.line(line);
          try {
            await buildAppImage({
              contextDir: repoDir,
              imageTag: tag,
              mode: service.buildMode as BuildMode,
              buildCmd: service.buildCmd,
              startCmd: service.startCmd,
              dockerfilePath: service.dockerfilePath,
              dockerTarget: service.dockerTarget,
              buildArgs: readVars(service.buildArgsEncrypted),
              onLogLine: onLog
            });
          } finally {
            await sink.end();
          }
          builtImages.set(key, tag);
          await prisma.serviceDeployment.update({
            where: { id: deployment.id },
            data: { status: "built", imageTag: tag, finishedAt: new Date() }
          });
        }
      }

      await ensureProjectNetwork(deps.docker, project.id);
      const sharedEnv = readVars(project.envVarsEncrypted);
      const datastoreEnvFor = (serviceId: string): Record<string, string> => {
        const env: Record<string, string> = {};
        for (const binding of project.datastoreBindings) {
          if (
            binding.serviceIds.length > 0 &&
            !binding.serviceIds.includes(serviceId)
          ) continue;
          const datastore = binding.datastore;
          if (datastore.status !== "running") {
            throw new Error(`Required datastore ${datastore.slug} is not healthy`);
          }
          const raw = readVars(datastore.credentialsEncrypted);
          const credentials: DatastoreCredentials = {
            username: raw.username,
            password: raw.password ?? "",
            database: raw.database
          };
          if (!credentials.password) {
            throw new Error(`Required datastore ${datastore.slug} has invalid credentials`);
          }
          const kind = datastore.kind as DatastoreKind;
          env[binding.envKey] = buildDatastoreConnectionUrl(
            kind,
            credentials,
            datastoreContainerName(datastore.slug),
            datastoreServicePort(kind)
          );
        }
        return env;
      };
      // Reconcile dependency networking before the release job. Provisioning
      // normally did this already; this also heals a removed Docker network.
      for (const binding of project.datastoreBindings) {
        const datastore = binding.datastore;
        if (datastore.status !== "running") {
          throw new Error(`Required datastore ${datastore.slug} is not healthy`);
        }
        const container = deps.docker.getContainer(
          datastoreContainerName(datastore.slug)
        );
        const info = await container.inspect();
        await deps.docker
          .getNetwork(projectInternalNetworkName(project.id))
          .connect({ Container: info.Id })
          .catch((error: unknown) => {
            const status =
              error && typeof error === "object" && "statusCode" in error
                ? Number((error as { statusCode?: number }).statusCode)
                : undefined;
            if (status !== 403) throw error;
          });
      }
      const releaseService = project.services.find((service) => service.kind === "release");

      if (releaseService) {
        await prisma.projectRelease.update({
          where: { id: release.id },
          data: { status: "releasing" }
        });
        const deployment = deployments.get(releaseService.id)!;
        const tag = (await prisma.serviceDeployment.findUniqueOrThrow({
          where: { id: deployment.id },
          select: { imageTag: true }
        })).imageTag;
        if (!tag) throw new Error("Release service has no built image");
        const vars = {
          ...sharedEnv,
          ...readVars(releaseService.envVarsEncrypted),
          ...datastoreEnvFor(releaseService.id)
        };
        const spec = buildProjectServiceContainerSpec({
          project,
          service: releaseService as ProjectServiceSpec,
          releaseId: release.id,
          serviceDeploymentId: deployment.id,
          imageTag: tag,
          envList: toDockerEnvList(vars),
          routing
        });
        const container = await deps.docker.createContainer(spec);
        const started = Math.floor(Date.now() / 1000) - 1;
        await container.start();
        await serviceLogs.start(
          {
            projectId: project.id,
            serviceId: releaseService.id,
            releaseId: release.id,
            serviceDeploymentId: deployment.id,
            containerId: container.id
          },
          container,
          [
            ...Object.values(vars),
            ...Object.values(readVars(releaseService.buildArgsEncrypted))
          ],
          started
        );
        const result = await container.wait();
        await serviceLogs.wait(deployment.id);
        await container.remove().catch(() => {});
        const exitCode = result.StatusCode ?? 1;
        await prisma.serviceDeployment.update({
          where: { id: deployment.id },
          data: {
            status: exitCode === 0 ? "success" : "failed",
            exitCode,
            containerId: container.id,
            finishedAt: new Date()
          }
        });
        if (exitCode !== 0) {
          throw new Error(`Release service ${releaseService.slug} exited with code ${String(exitCode)}`);
        }
      }

      await prisma.projectRelease.update({
        where: { id: release.id },
        data: { status: "deploying", commitSha, commitMessage }
      });

      const candidates: Array<{
        service: (typeof project.services)[number];
        deploymentId: string;
        container: Docker.Container;
        secrets: string[];
      }> = [];
      try {
        for (const service of project.services.filter((item) => item.kind !== "release")) {
          const deployment = deployments.get(service.id)!;
          const current = await prisma.serviceDeployment.findUniqueOrThrow({
            where: { id: deployment.id },
            select: { imageTag: true }
          });
          if (!current.imageTag) throw new Error(`Service ${service.slug} has no image`);
          const vars = {
            ...sharedEnv,
            ...readVars(service.envVarsEncrypted),
            ...datastoreEnvFor(service.id)
          };
          const container = await deps.docker.createContainer(
            buildProjectServiceContainerSpec({
              project,
              service: service as ProjectServiceSpec,
              releaseId: release.id,
              serviceDeploymentId: deployment.id,
              imageTag: current.imageTag,
              envList: toDockerEnvList(vars),
              routing
            })
          );
          candidates.push({
            service,
            deploymentId: deployment.id,
            container,
            secrets: [
              ...Object.values(vars),
              ...Object.values(readVars(service.buildArgsEncrypted))
            ]
          });
        }

        const candidateByService = new Map(
          candidates.map((candidate) => [candidate.service.id, candidate])
        );
        const ready = new Set<string>();
        const ensureReady = async (candidate: (typeof candidates)[number]) => {
          if (ready.has(candidate.service.id)) return;
          await waitForCandidateReady(candidate.container, candidate.service);
          ready.add(candidate.service.id);
          await systemLog(
            {
              projectId: project.id,
              serviceId: candidate.service.id,
              releaseId: release.id,
              serviceDeploymentId: candidate.deploymentId,
              containerId: candidate.container.id,
              restartNumber: 0
            },
            "[sohwe] Service is ready"
          );
        };

        for (const service of orderRuntimeServices(project.services)) {
          const candidate = candidateByService.get(service.id)!;
          for (const dependency of service.dependencies) {
            const dependencyCandidate = candidateByService.get(
              dependency.dependencyService.id
            );
            if (!dependencyCandidate) {
              throw new Error(
                `Service ${service.slug} depends on unavailable service ${dependency.dependencyService.slug}`
              );
            }
            if (dependency.condition === "healthy") {
              await ensureReady(dependencyCandidate);
            }
          }
          const since = Math.floor(Date.now() / 1000) - 1;
          await candidate.container.start();
          await serviceLogs.start(
            {
              projectId: project.id,
              serviceId: candidate.service.id,
              releaseId: release.id,
              serviceDeploymentId: candidate.deploymentId,
              containerId: candidate.container.id
            },
            candidate.container,
            candidate.secrets,
            since
          );
          await prisma.serviceDeployment.update({
            where: { id: candidate.deploymentId },
            data: {
              status: "running",
              containerId: candidate.container.id,
              startedAt: new Date()
            }
          });
          await systemLog(
            {
              projectId: project.id,
              serviceId: candidate.service.id,
              releaseId: release.id,
              serviceDeploymentId: candidate.deploymentId,
              containerId: candidate.container.id,
              restartNumber: 0
            },
            "[sohwe] Service started"
          );
        }
        await Promise.all(candidates.map(ensureReady));

        // Traefik cannot see candidates while they are being checked. Attach
        // routed services only after the whole release is ready, then retire
        // the old containers below.
        await Promise.all(
          candidates
            .filter((candidate) => candidate.service.kind === "http")
            .map((candidate) =>
              connectHttpServiceToRoutingNetwork(
                deps.docker,
                routing.network,
                candidate.container.id
              )
            )
        );
      } catch (error) {
        for (const candidate of candidates) {
          serviceLogs.stop(candidate.deploymentId);
          await candidate.container.stop({ t: 10 }).catch(() => {});
          await candidate.container.remove().catch(() => {});
        }
        throw error;
      }

      // Promotion boundary: builds and the release job have succeeded and all
      // candidate runtime containers have started. Only now retire the old set.
      await stopAndRemoveProjectContainers(deps.docker, project.id, release.id);
      await prisma.$transaction([
        prisma.serviceDeployment.updateMany({
          where: { releaseId: release.id, service: { kind: { not: "release" } } },
          data: { status: "success" }
        }),
        prisma.projectRelease.update({
          where: { id: release.id },
          data: {
            status: "success",
            commitSha,
            commitMessage,
            finishedAt: new Date()
          }
        }),
        prisma.project.update({
          where: { id: project.id },
          data: { status: "running", currentReleaseId: release.id }
        })
      ]);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = redactDeployError(raw, github);
      await prisma.$transaction([
        prisma.projectRelease.update({
          where: { id: release.id },
          data: { status: "failed", errorMessage: message, finishedAt: new Date() }
        }),
        prisma.serviceDeployment.updateMany({
          where: {
            releaseId: release.id,
            status: { in: ["pending", "building", "built", "running"] }
          },
          data: { status: "failed", errorMessage: message, finishedAt: new Date() }
        }),
        prisma.project.update({
          where: { id: project.id },
          // A failed candidate leaves the last successful release live.
          data: { status: project.currentReleaseId ? "running" : "idle" }
        })
      ]).catch(() => {});
      throw new Error(message, { cause: error });
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function recover(): Promise<void> {
    const containers = await deps.docker.listContainers({
      filters: {
        label: ["sohwe.managed=true"],
        status: ["running"]
      }
    });
    for (const row of containers) {
      const deploymentId = row.Labels?.["sohwe.service-deployment"];
      if (!deploymentId) continue;
      const deployment = await prisma.serviceDeployment.findUnique({
        where: { id: deploymentId },
        include: {
          release: { select: { id: true, projectId: true } },
          service: {
            select: {
              id: true,
              envVarsEncrypted: true,
              buildArgsEncrypted: true,
              project: {
                select: {
                  envVarsEncrypted: true,
                  datastoreBindings: { include: { datastore: true } }
                }
              }
            }
          }
        }
      });
      if (!deployment) continue;
      const shared = readVars(deployment.service.project.envVarsEncrypted);
      const own = readVars(deployment.service.envVarsEncrypted);
      const buildSecrets = readVars(deployment.service.buildArgsEncrypted);
      const dependencySecrets: string[] = [];
      for (const binding of deployment.service.project.datastoreBindings) {
        if (
          binding.serviceIds.length > 0 &&
          !binding.serviceIds.includes(deployment.serviceId)
        ) continue;
        const vars = readVars(binding.datastore.credentialsEncrypted);
        dependencySecrets.push(...Object.values(vars));
      }
      const last = await prisma.serviceLog.findFirst({
        where: {
          serviceDeploymentId: deployment.id,
          containerId: row.Id,
          containerTimestamp: { not: null }
        },
        orderBy: { id: "desc" },
        select: { containerTimestamp: true }
      });
      const since = last?.containerTimestamp
        ? Math.max(0, Math.floor(last.containerTimestamp.getTime() / 1000) - 1)
        : 0;
      await serviceLogs.start(
        {
          projectId: deployment.release.projectId,
          serviceId: deployment.serviceId,
          releaseId: deployment.releaseId,
          serviceDeploymentId: deployment.id,
          containerId: row.Id
        },
        deps.docker.getContainer(row.Id),
        [
          ...Object.values(shared),
          ...Object.values(own),
          ...Object.values(buildSecrets),
          ...dependencySecrets
        ],
        since
      );
    }
  }

  return { deploy, recover, stop: () => serviceLogs.stopAll() };
}
