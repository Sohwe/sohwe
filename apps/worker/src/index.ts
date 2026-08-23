import { config } from "dotenv";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAppImage, type BuildMode } from "@sohwe/builder";
import { decryptJson, getSohweEncryptionKey, toDockerEnvList } from "@sohwe/crypto";
import { prisma } from "@sohwe/db";
import {
  appLogChannelName,
  createRedisForPublish,
  DEPLOY_QUEUE,
  getConnectionOptionsForBull,
  logChannelName,
  Worker,
  type DeployJobData
} from "@sohwe/queue";
import Docker from "dockerode";
import { startBackupSubsystem, type BackupSubsystem } from "./backups";
import { startDatastoreSubsystem, type DatastoreSubsystem } from "./datastores";
import {
  BUILD_FAILURE_SCAN_LINES,
  formatBuildFailureSummary,
  summarizeBuildFailure
} from "./build-failure";
import { LogSink } from "./build-log";
import {
  buildContainerSpec,
  buildHostRule,
  resolveHosts,
  resolveRoutingConfig,
  shouldUseTls
} from "./container-spec";
import { buildAlertPayload, createDockerEventWatcher } from "./crash-watch";
import {
  connectToInternalNetwork,
  ensureAppVolumes,
  stopAndRemoveAppContainers
} from "./docker-ops";
import {
  redactDeployError,
  reportCommitStatus,
  resolveGitHubContext,
  type GitHubDeployContext
} from "./github";
import { createRuntimeLogTailManager } from "./runtime-logs";
import { createStatsSampler } from "./stats";

const _here = dirname(fileURLToPath(import.meta.url));
config({ path: join(_here, "../../../.env") });
config({ path: join(_here, "../../api/.env") });
config();

/**
 * Decrypt one of an application's `*Encrypted` variable blobs. Prisma hands
 * back `Bytes` as a Buffer at runtime, but the generated type allows
 * `Uint8Array`, so normalize before decrypting.
 */
function readEncryptedVars(
  enc: Buffer | Uint8Array | null | undefined
): Record<string, string> {
  if (!enc || enc.length === 0) return {};
  return decryptJson(Buffer.isBuffer(enc) ? enc : Buffer.from(enc));
}

// Fail fast on a misconfigured environment before opening any connection. The
// encryption key is the important one: without this it only throws when a
// deploy job first decrypts env vars, failing the deploy in a confusing place
// instead of refusing to start. It must also match the API's key, or encrypted
// env vars written by the API cannot be decrypted here.
function validateWorkerEnv(): void {
  const errors: string[] = [];
  for (const name of ["DATABASE_URL", "REDIS_URL"] as const) {
    const v = process.env[name];
    if (!v || v.trim().length === 0) errors.push(`${name} is required but is not set`);
  }
  try {
    getSohweEncryptionKey();
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  if (errors.length > 0) {
    console.error(
      "Invalid worker environment configuration:\n" +
        errors.map((e) => `  - ${e}`).join("\n") +
        "\nSOHWE_ENCRYPTION_KEY must match the value used by the API."
    );
    process.exit(1);
  }
}
validateWorkerEnv();

const MAX_COMMIT_MSG = 2000;

const docker = new Docker();
const publishRedis = createRedisForPublish();

// Runtime log tails, one follow-stream per app, published to the app's Redis
// log channel. Logic lives in `runtime-logs.ts`; this wires it to the real
// Docker daemon and Redis.
const logTails = createRuntimeLogTailManager({
  docker,
  publish: (appId, line) => {
    void publishRedis.publish(appLogChannelName(appId), line);
  },
  demux: (stream, stdout, stderr) => {
    (
      docker.modem as {
        demuxStream(
          stream: NodeJS.ReadableStream,
          stdout: NodeJS.WritableStream,
          stderr: NodeJS.WritableStream
        ): void;
      }
    ).demuxStream(stream, stdout, stderr);
  }
});

// Live CPU/memory stats (Phase 4). Sampling logic lives in `stats.ts`.
const statsSampler = createStatsSampler({
  docker,
  setStat: (key, json, ttlSeconds) => publishRedis.set(key, json, "EX", ttlSeconds)
});

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

/**
 * Shallow-clone the tracked branch. `url` may carry an installation token as
 * basic-auth, and git echoes the remote back in its error output, so failures
 * are redacted before they can reach a build log or the deployment row.
 */
async function gitClone(
  url: string,
  branch: string,
  dest: string,
  github: GitHubDeployContext | null
): Promise<void> {
  try {
    await sh(
      "git",
      ["clone", "--depth", "1", "-b", branch, url, dest],
      process.cwd()
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(redactDeployError(msg, github));
  }
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

function buildImageTag(slug: string, deploymentId: string): string {
  return `sohwe/app-${slug}:dep-${deploymentId}`.toLowerCase();
}

async function sendCrashAlerts(
  appId: string,
  event: string,
  exitCode: string,
  containerId: string
): Promise<void> {
  const app = await prisma.application.findUnique({
    where: { id: appId },
    select: { id: true, name: true, slug: true }
  });
  if (!app) return;

  const destinations = await prisma.alertDestination.findMany({
    where: { applicationId: appId, enabled: true }
  });
  if (destinations.length === 0) return;

  const info = {
    appName: app.name,
    appSlug: app.slug,
    event,
    exitCode,
    containerId,
    timeIso: new Date().toISOString()
  };

  await Promise.all(
    destinations.map(async (d) => {
      try {
        await fetch(d.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildAlertPayload(d.type, info))
        });
      } catch (e) {
        console.error(
          `Failed to send crash alert to destination ${d.id}`,
          e instanceof Error ? e.message : e
        );
      }
    })
  );
}

// Crash detection (Phase 4). Classification and the reconnecting event stream
// live in `crash-watch.ts`; this binds a confirmed crash to the DB status flip
// and the webhook alerts.
const eventWatcher = createDockerEventWatcher({
  // Wrapped rather than passed directly: dockerode's callback-style overloads
  // of getEvents defeat structural assignability to the narrow EventsDocker.
  docker: { getEvents: (opts) => docker.getEvents(opts) },
  onCrash: async (crash) => {
    await prisma.application
      .update({ where: { id: crash.appId }, data: { status: "crashed" } })
      .catch(() => {});
    await sendCrashAlerts(
      crash.appId,
      crash.event,
      crash.exitCode,
      crash.containerId
    );
  }
});

async function runDeploy(job: { data: DeployJobData }): Promise<void> {
  const { deploymentId, applicationId, promoteImageFromDeploymentId } = job.data;

  let workDir: string | null = null;
  // Set once the repo is cloned through a GitHub App installation; drives
  // commit-status reporting and token redaction on failure.
  let github: GitHubDeployContext | null = null;
  // Declared out here so the failure path can still report a commit status;
  // the deployment row only records the sha on success.
  let commitSha: string | null = null;
  const app = await prisma.application.findFirst({
    where: { id: applicationId },
    // Custom domains all become `Host()` terms on the container's Traefik
    // router. Primary first so it leads the rule and reads as *the* URL.
    include: {
      domains: {
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: { hostname: true }
      }
    }
  });
  if (!app) {
    throw new Error(`Application ${applicationId} not found`);
  }

  const dep = await prisma.deployment.findFirst({
    where: { id: deploymentId, applicationId: app.id }
  });
  if (!dep) {
    throw new Error(`Deployment ${deploymentId} not found`);
  }

  // HTTPS is opt-in via `SOHWE_HTTPS_ENABLED=true` (the operator also has to
  // configure an ACME resolver + websecure entrypoint in Traefik), and only
  // applies to a host Let's Encrypt could issue for — see `container-spec.ts`,
  // which owns every routing and container-shape decision from here on.
  const routing = resolveRoutingConfig();

  const logChannel = logChannelName(deploymentId);
  const emit = (line: string) => {
    void publishRedis.publish(logChannel, line);
  };

  const sink = new LogSink({
    // Concatenate in the database. Reading the column back to build the new
    // value would make a long build cost O(n^2) in traffic and would race with
    // any other writer of the same row.
    append: async (addition) => {
      await prisma.$executeRaw`
        UPDATE "deployments"
        SET "build_logs" = COALESCE("build_logs", '') || ${addition}
        WHERE "id" = ${deploymentId}
      `;
    },
    // Only reached once the log is truncated, where the value is capped.
    replace: async (text) => {
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { buildLogs: text }
      });
    }
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
      // Clear the log: the sink appends, so a retried job would otherwise
      // stack this attempt's output onto the previous attempt's.
      data: {
        status: "building",
        startedAt: new Date(),
        buildLogs: "",
        errorMessage: null
      }
    });
    await prisma.application.update({
      where: { id: app.id },
      data: { status: "deploying" }
    });

    let imageTag: string;
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

      // An installation token, when one is available, is what makes private
      // repositories clonable. Public repos work either way.
      github = await resolveGitHubContext(app).catch((e: unknown) => {
        onLog(
          `[sohwe] Could not get a GitHub installation token: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
        return null;
      });

      // Log the clean URL, never the tokenized one.
      onLog(
        `[sohwe] Cloning ${app.gitRepo} (branch: ${app.gitBranch})${
          github ? " using the GitHub App installation" : ""
        } into ${repoDir}...`
      );
      await gitClone(
        github?.cloneUrl ?? app.gitRepo,
        app.gitBranch,
        repoDir,
        github
      );
      commitSha = await getCommitSha(repoDir);
      commitMessage = await getCommitSubject(repoDir);
      onLog(`[sohwe] At commit ${commitSha}`);

      await reportCommitStatus(github, {
        commitSha,
        state: "pending",
        description: `Deploying ${app.name}`,
        applicationId: app.id,
        deploymentId
      });

      onLog(`[sohwe] Building image...`);
      imageTag = buildImageTag(app.slug, deploymentId);
      await buildAppImage({
        contextDir: repoDir,
        imageTag,
        mode: (app.buildMode as BuildMode) ?? "auto",
        buildCmd: app.buildCmd,
        startCmd: app.startCmd,
        buildArgs: readEncryptedVars(app.buildArgsEncrypted),
        onLogLine: onLog
      });
    }

    await sink.end();
    onLog(`[sohwe] Stopping old containers for this app (if any)...`);
    logTails.stop(app.id);
    await stopAndRemoveAppContainers(docker, app.id);

    const specApp = { ...app, domains: app.domains.map((d) => d.hostname) };
    const hosts = resolveHosts(specApp, routing.baseDomain);
    onLog(
      `[sohwe] Starting container (Traefik: ${buildHostRule(hosts)}, port ${String(app.port)}, tls=${String(shouldUseTls(hosts, routing.httpsEnabled))})...`
    );

    const vols = await prisma.volume.findMany({ where: { applicationId: app.id } });
    await ensureAppVolumes(docker, app.id, vols);

    const envList: string[] = toDockerEnvList(
      readEncryptedVars(app.envVarsEncrypted)
    );

    const c = await docker.createContainer(
      buildContainerSpec({
        app: specApp,
        deploymentId,
        imageTag,
        volumes: vols,
        envList,
        routing
      })
    );

    await c.start();
    await logTails.start(app.id, c, Math.floor(Date.now() / 1000) - 1);

    await connectToInternalNetwork(docker, app.id, c.id);

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

    await reportCommitStatus(github, {
      commitSha,
      state: "success",
      description: `Deployed ${app.name}`,
      applicationId: app.id,
      deploymentId
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // The error can be derived from a tokenized clone URL, so redact before it
    // reaches the log stream, the deployment row, or the rethrow.
    const msg = redactDeployError(raw, github);

    // "docker build failed with exit code 1" is the shape of almost every build
    // error and explains nothing, so derive a cause from the log tail before
    // the sink is closed. The log lines are redacted for the same reason `msg`
    // is: anything derived from a failed clone can carry an installation token.
    const summary = summarizeBuildFailure({
      errorMessage: msg,
      recentLines: sink
        .recentLines(BUILD_FAILURE_SCAN_LINES)
        .map((l) => redactDeployError(l, github))
    });
    const failureText = formatBuildFailureSummary(summary, msg);

    emit(`[sohwe] ERROR: ${msg}`);
    sink.line(`[sohwe] ERROR: ${msg}`);
    await sink.end();
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: "failed",
        errorMessage: failureText,
        finishedAt: new Date()
      }
    });
    await prisma.application
      .update({
        where: { id: app.id },
        data: { status: "idle" }
      })
      .catch(() => {});

    await reportCommitStatus(github, {
      commitSha,
      state: "failure",
      description: `Deploy failed for ${app.name}`,
      applicationId: app.id,
      deploymentId
    });

    throw new Error(msg, { cause: e });
  } finally {
    await cleanupWorkdir();
  }
}

const connection = getConnectionOptionsForBull();
const worker = new Worker<DeployJobData>(DEPLOY_QUEUE, async (job) => {
  await runDeploy({ data: job.data });
}, { connection });

await logTails.startForRunning().catch((e) => {
  console.error("Failed to attach runtime log tails", e);
});

statsSampler.start();
await eventWatcher.start().catch((e) => {
  console.error("Failed to start Docker event watcher", e);
});

let backups: BackupSubsystem | null = null;
try {
  backups = await startBackupSubsystem();
} catch (e) {
  console.error("Failed to start backup subsystem", e);
}

let datastores: DatastoreSubsystem | null = null;
try {
  datastores = await startDatastoreSubsystem(docker);
} catch (e) {
  console.error("Failed to start datastore subsystem", e);
}

worker.on("failed", (job, err) => {
  console.error("Job failed", job?.id, err);
});
worker.on("error", (err) => {
  console.error("Worker error", err);
});

const shutdown = async () => {
  statsSampler.stop();
  eventWatcher.stop();
  logTails.stopAll();
  await worker.close();
  if (backups) await backups.close();
  if (datastores) await datastores.close();
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
