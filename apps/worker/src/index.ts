import { config } from "dotenv";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerBuild } from "@sohwe/builder";
import { prisma } from "@sohwe/db";
import {
  createRedisForPublish,
  DEPLOY_QUEUE,
  getConnectionOptionsForBull,
  logChannelName,
  Worker,
  type DeployJobData
} from "@sohwe/queue";
import Docker from "dockerode";

const _here = dirname(fileURLToPath(import.meta.url));
config({ path: join(_here, "../../.env") });
config({ path: join(_here, "../api/.env") });
config();

const MAX_COMMIT_MSG = 2000;

const docker = new Docker();
const publishRedis = createRedisForPublish();

function sh(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr?.on("data", (b) => {
      err += b.toString();
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${cmd} ${args.join(" ")} failed (${String(code)}): ${err || "no stderr"}`
          )
        );
    });
  });
}

async function gitClone(
  url: string,
  branch: string,
  dest: string
): Promise<void> {
  await sh("git", ["clone", "--depth", "1", "-b", branch, url, dest], process.cwd());
}

async function getCommitSha(repoDir: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const p = spawn("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    let out = "";
    p.stdout?.on("data", (b) => {
      out += b.toString();
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error("git rev-parse failed"));
    });
  });
}

/** First line of the latest commit (subject), for deployment UI. */
async function getCommitSubject(repoDir: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const p = spawn("git", ["log", "-1", "--pretty=format:%s"], { cwd: repoDir });
    let out = "";
    p.stdout?.on("data", (b) => {
      out += b.toString();
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) {
        const s = out.replace(/\r\n/g, "\n").split("\n")[0]?.trim() ?? "";
        resolve(s.slice(0, MAX_COMMIT_MSG));
      } else reject(new Error("git log for subject failed"));
    });
  });
}

class LogSink {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly flush: (addition: string) => Promise<void>) {}

  line(text: string): void {
    const line = text.endsWith("\n") ? text : `${text}\n`;
    this.buffer += line;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const b = this.buffer;
      this.buffer = "";
      if (b) void this.flush(b);
    }, 200);
  }

  async end(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer) {
      const b = this.buffer;
      this.buffer = "";
      await this.flush(b);
    }
  }
}

function traefikName(slug: string): string {
  return `w${slug.replace(/[^a-z0-9]/g, "")}`.slice(0, 50) || "wapp";
}

function buildImageTag(slug: string, deploymentId: string): string {
  return `sohwe/app-${slug}:dep-${deploymentId}`.toLowerCase();
}

async function runDeploy(job: { data: DeployJobData }): Promise<void> {
  const { deploymentId, applicationId, promoteImageFromDeploymentId } = job.data;

  let workDir: string | null = null;
  const app = await prisma.application.findFirst({
    where: { id: applicationId }
  });
  if (!app) {
    throw new Error(`Application ${applicationId} not found`);
  }
  if (app.buildMode === "nixpacks") {
    throw new Error("Nixpacks builds are not available yet (Phase 2).");
  }

  const dep = await prisma.deployment.findFirst({
    where: { id: deploymentId, applicationId: app.id }
  });
  if (!dep) {
    throw new Error(`Deployment ${deploymentId} not found`);
  }

  const baseDomain = process.env.SOHWE_BASE_DOMAIN ?? "sohwe.localhost";
  const hostRule = app.domain
    ? app.domain
    : `${app.slug}.${baseDomain}`;
  const traefikR = traefikName(app.slug);
  const network = process.env.TRAEFIK_DOCKER_NETWORK ?? "sohwe_proxy";

  const logChannel = logChannelName(deploymentId);
  const emit = (line: string) => {
    void publishRedis.publish(logChannel, line);
  };

  const sink = new LogSink(async (addition) => {
    const cur = await prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { buildLogs: true }
    });
    const next = (cur?.buildLogs ?? "") + addition;
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { buildLogs: next }
    });
  });

  const onLog = (l: string) => {
    emit(l);
    sink.line(l);
  };

  const cleanupWorkdir = async () => {
    if (workDir) {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      workDir = null;
    }
  };

  try {
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: "building", startedAt: new Date() }
    });
    await prisma.application.update({
      where: { id: app.id },
      data: { status: "deploying" }
    });

    let imageTag: string;
    let commitSha: string | null = null;
    let commitMessage: string | null = null;

    if (promoteImageFromDeploymentId) {
      const prev = await prisma.deployment.findFirst({
        where: {
          id: promoteImageFromDeploymentId,
          applicationId: app.id
        }
      });
      if (!prev?.imageTag) {
        throw new Error("Source deployment has no image tag to promote");
      }
      onLog(`[sohwe] Reusing image ${prev.imageTag} (rollback/promote)`);
      imageTag = prev.imageTag;
      commitSha = prev.commitSha ?? null;
      commitMessage = prev.commitMessage ?? null;
    } else {
      workDir = await mkdtemp(join(tmpdir(), "sohwe-"));
      const repoDir = join(workDir, "repo");
      onLog(
        `[sohwe] Cloning ${app.gitRepo} (branch: ${app.gitBranch}) into ${repoDir}...`
      );
      await gitClone(app.gitRepo, app.gitBranch, repoDir);
      commitSha = await getCommitSha(repoDir);
      commitMessage = await getCommitSubject(repoDir);
      onLog(`[sohwe] At commit ${commitSha}`);
      onLog(`[sohwe] Building image...`);
      imageTag = buildImageTag(app.slug, deploymentId);
      await dockerBuild({
        contextDir: repoDir,
        imageTag,
        onLogLine: onLog
      });
    }

    await sink.end();
    onLog(`[sohwe] Stopping old containers for this app (if any)...`);
    const existing = await docker.listContainers({
      all: true,
      filters: { label: [`sohwe.app=${app.id}`] }
    });
    for (const c of existing) {
      const d = docker.getContainer(c.Id);
      await d.stop({ t: 10 }).catch(() => {});
      await d.remove().catch(() => {});
    }

    onLog(
      `[sohwe] Starting container (Traefik: Host(\`${hostRule}\`), port ${String(app.port)})...`
    );

    const containerName =
      `sohwe-${app.slug}`.replace(/[^a-z0-9-]/g, "-").slice(0, 63) || "sohwe-app";

    const port = app.port;
    const labels: Record<string, string> = {
      "traefik.enable": "true",
      "traefik.docker.network": network,
      [`traefik.http.routers.${traefikR}.rule`]: `Host(\`${hostRule}\`)`,
      [`traefik.http.routers.${traefikR}.entrypoints`]: "web",
      [`traefik.http.routers.${traefikR}.service`]: traefikR,
      [`traefik.http.services.${traefikR}.loadbalancer.server.port`]: String(
        port
      ),
      "sohwe.managed": "true",
      "sohwe.app": app.id,
      "sohwe.deployment": deploymentId
    };

    const c = await docker.createContainer({
      name: containerName,
      Image: imageTag,
      Labels: labels,
      ExposedPorts: { [`${port}/tcp`]: {} },
      HostConfig: {
        NetworkMode: network,
        RestartPolicy: { Name: "unless-stopped" }
      }
    });

    await c.start();

    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: "success",
        imageTag,
        commitSha,
        commitMessage,
        finishedAt: new Date()
      }
    });
    await prisma.application.update({
      where: { id: app.id },
      data: { status: "running" }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit(`[sohwe] ERROR: ${msg}`);
    sink.line(`[sohwe] ERROR: ${msg}`);
    await sink.end();
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: "failed",
        errorMessage: msg,
        finishedAt: new Date()
      }
    });
    await prisma.application
      .update({
        where: { id: app.id },
        data: { status: "idle" }
      })
      .catch(() => {});
    throw e;
  } finally {
    await cleanupWorkdir();
  }
}

const connection = getConnectionOptionsForBull();
const worker = new Worker<DeployJobData>(DEPLOY_QUEUE, async (job) => {
  await runDeploy({ data: job.data });
}, { connection });

worker.on("failed", (job, err) => {
  console.error("Job failed", job?.id, err);
});
worker.on("error", (err) => {
  console.error("Worker error", err);
});

const shutdown = async () => {
  await worker.close();
  await publishRedis.quit();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

console.log("Sohwe worker started");
