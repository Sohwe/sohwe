import { config } from "dotenv";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { buildAppImage, type BuildMode } from "@sohwe/builder";
import { decryptJson, getSohweEncryptionKey, toDockerEnvList } from "@sohwe/crypto";
import { appDockerVolumeName, appInternalNetworkName } from "@sohwe/types";
import { prisma } from "@sohwe/db";
import {
  appLogChannelName,
  appStatsKey,
  createRedisForPublish,
  DEPLOY_QUEUE,
  getConnectionOptionsForBull,
  logChannelName,
  Worker,
  type DeployJobData
} from "@sohwe/queue";
import Docker from "dockerode";
import { startBackupSubsystem, type BackupSubsystem } from "./backups";

const _here = dirname(fileURLToPath(import.meta.url));
config({ path: join(_here, "../../../.env") });
config({ path: join(_here, "../../api/.env") });
config();

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
const runtimeLogTails = new Map<
  string,
  { containerId: string; stream: NodeJS.ReadableStream & { destroy?(): void } }
>();

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

function publishRuntimeLine(applicationId: string, line: string): void {
  void publishRedis.publish(appLogChannelName(applicationId), line);
}

function stopRuntimeLogTail(applicationId: string): void {
  const tail = runtimeLogTails.get(applicationId);
  if (!tail) return;
  runtimeLogTails.delete(applicationId);
  tail.stream.destroy?.();
}

async function startRuntimeLogTail(
  applicationId: string,
  container: Docker.Container,
  since = Math.floor(Date.now() / 1000)
): Promise<void> {
  stopRuntimeLogTail(applicationId);

  let stream: NodeJS.ReadableStream & { destroy?(): void };
  try {
    stream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: false,
      since
    })) as NodeJS.ReadableStream & { destroy?(): void };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    publishRuntimeLine(applicationId, `[sohwe] Failed to attach runtime logs: ${msg}`);
    return;
  }

  runtimeLogTails.set(applicationId, { containerId: container.id, stream });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = "";

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) publishRuntimeLine(applicationId, line);
    }
  };

  const onEnd = () => {
    if (buffer.length > 0) {
      publishRuntimeLine(applicationId, buffer);
      buffer = "";
    }
    const current = runtimeLogTails.get(applicationId);
    if (current?.containerId === container.id) {
      runtimeLogTails.delete(applicationId);
    }
    stdout.destroy();
    stderr.destroy();
  };

  stdout.on("data", onData);
  stderr.on("data", onData);
  stream.on("end", onEnd);
  stream.on("close", onEnd);
  stream.on("error", (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    publishRuntimeLine(applicationId, `[sohwe] Runtime log stream ended: ${msg}`);
    onEnd();
  });

  try {
    (
      docker.modem as {
        demuxStream(
          stream: NodeJS.ReadableStream,
          stdout: NodeJS.WritableStream,
          stderr: NodeJS.WritableStream
        ): void;
      }
    ).demuxStream(stream, stdout, stderr);
  } catch {
    stream.on("data", onData);
  }
}

async function startRuntimeLogTailsForRunningContainers(): Promise<void> {
  const containers = await docker.listContainers({
    filters: { label: ["sohwe.managed=true"] }
  });
  for (const c of containers) {
    const appId = c.Labels?.["sohwe.app"];
    if (!appId) continue;
    await startRuntimeLogTail(appId, docker.getContainer(c.Id));
  }
}

// --- Live CPU/memory stats (Phase 4) ---------------------------------------
//
// Every few seconds we sample one-shot Docker stats for each managed running
// container and write a compact JSON snapshot to Redis under `stats:app:<id>`
// with a short TTL. The API reads this key (polling); when it expires the app
// is reported as not running. We deliberately avoid streaming stats — periodic
// one-shot reads are simpler and the daemon still populates `precpu_stats` so
// the standard CPU% delta formula works.

const STATS_INTERVAL_MS = 3000;
const STATS_TTL_SECONDS = 10;
let statsTimer: ReturnType<typeof setInterval> | null = null;

type RawDockerStats = {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { cache?: number; inactive_file?: number };
  };
};

function computeStats(raw: RawDockerStats): {
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  memPercent: number;
} {
  const cpuTotal = raw.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const preTotal = raw.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const system = raw.cpu_stats?.system_cpu_usage ?? 0;
  const preSystem = raw.precpu_stats?.system_cpu_usage ?? 0;
  const onlineCpus = raw.cpu_stats?.online_cpus ?? 1;
  const cpuDelta = cpuTotal - preTotal;
  const systemDelta = system - preSystem;
  const cpuPercent =
    systemDelta > 0 && cpuDelta > 0
      ? (cpuDelta / systemDelta) * onlineCpus * 100
      : 0;

  const rawUsage = raw.memory_stats?.usage ?? 0;
  // Match `docker stats`: subtract page cache (cgroup v1 `cache`, v2 `inactive_file`).
  const cache =
    raw.memory_stats?.stats?.cache ??
    raw.memory_stats?.stats?.inactive_file ??
    0;
  const memUsedBytes = Math.max(0, rawUsage - cache);
  const memLimitBytes = raw.memory_stats?.limit ?? 0;
  const memPercent =
    memLimitBytes > 0 ? (memUsedBytes / memLimitBytes) * 100 : 0;

  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memUsedBytes,
    memLimitBytes,
    memPercent: Math.round(memPercent * 10) / 10
  };
}

async function sampleStatsOnce(): Promise<void> {
  const containers = await docker.listContainers({
    filters: { label: ["sohwe.managed=true"], status: ["running"] }
  });
  await Promise.all(
    containers.map(async (c) => {
      const appId = c.Labels?.["sohwe.app"];
      if (!appId) return;
      try {
        const raw = (await docker
          .getContainer(c.Id)
          .stats({ stream: false })) as RawDockerStats;
        const s = computeStats(raw);
        await publishRedis.set(
          appStatsKey(appId),
          JSON.stringify({ running: true, ...s, ts: Date.now() }),
          "EX",
          STATS_TTL_SECONDS
        );
      } catch {
        // Container may have stopped between listing and sampling; skip.
      }
    })
  );
}

function startStatsCollector(): void {
  if (statsTimer) return;
  statsTimer = setInterval(() => {
    void sampleStatsOnce().catch(() => {});
  }, STATS_INTERVAL_MS);
}

function stopStatsCollector(): void {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

// --- Crash detection + webhook alerts (Phase 4) ----------------------------
//
// We watch Docker `die`/`oom` events for managed containers. On a crash we mark
// the app `crashed` and POST a webhook to each enabled per-app destination.
// Alert payloads carry only non-sensitive metadata (app name/slug, event, exit
// code, container id, timestamp) — never env var values or other secrets.

type DockerEvent = {
  Type?: string;
  Action?: string;
  status?: string;
  id?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
};

let eventsStream: (NodeJS.ReadableStream & { destroy?(): void }) | null = null;
let eventsStopping = false;

function buildAlertPayload(
  type: string,
  info: {
    appName: string;
    appSlug: string;
    event: string;
    exitCode: string;
    containerId: string;
    timeIso: string;
  }
): unknown {
  const title = `🔴 Sohwe: app "${info.appName}" ${info.event}`;
  const detail =
    `App: ${info.appName} (${info.appSlug})\n` +
    `Event: ${info.event}\n` +
    `Exit code: ${info.exitCode}\n` +
    `Container: ${info.containerId.slice(0, 12)}\n` +
    `Time: ${info.timeIso}`;
  if (type === "slack") {
    return { text: `${title}\n${detail}` };
  }
  if (type === "discord") {
    return { content: `**${title}**\n${detail}` };
  }
  // generic
  return {
    type: "sohwe.crash",
    app: { name: info.appName, slug: info.appSlug },
    event: info.event,
    exitCode: info.exitCode,
    containerId: info.containerId,
    time: info.timeIso
  };
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

async function handleDockerEvent(ev: DockerEvent): Promise<void> {
  if (ev.Type && ev.Type !== "container") return;
  const action = ev.Action ?? ev.status ?? "";
  const isOom = action === "oom";
  const isDie = action === "die";
  if (!isOom && !isDie) return;

  const attrs = ev.Actor?.Attributes ?? {};
  const appId = attrs["sohwe.app"];
  if (!appId) return;

  const exitCode = attrs.exitCode ?? "";
  // A clean stop (exit 0) is not a crash; an OOM kill always is.
  if (isDie && (exitCode === "0" || exitCode === "")) return;

  const containerId = ev.Actor?.ID ?? ev.id ?? "";
  await prisma.application
    .update({ where: { id: appId }, data: { status: "crashed" } })
    .catch(() => {});
  await sendCrashAlerts(appId, isOom ? "out of memory" : "crashed", exitCode, containerId);
}

async function startDockerEventWatcher(): Promise<void> {
  if (eventsStopping) return;
  try {
    eventsStream = (await docker.getEvents({
      filters: {
        type: ["container"],
        event: ["die", "oom"],
        label: ["sohwe.managed=true"]
      }
    })) as NodeJS.ReadableStream & { destroy?(): void };
  } catch (e) {
    console.error("Failed to subscribe to Docker events", e);
    return;
  }

  let buffer = "";
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        void handleDockerEvent(JSON.parse(trimmed) as DockerEvent);
      } catch {
        // ignore malformed line
      }
    }
  };

  const reconnect = () => {
    eventsStream = null;
    if (eventsStopping) return;
    setTimeout(() => {
      void startDockerEventWatcher();
    }, 1000);
  };

  eventsStream.on("data", onData);
  eventsStream.on("end", reconnect);
  eventsStream.on("close", reconnect);
  eventsStream.on("error", (e) => {
    console.error("Docker events stream error", e);
    reconnect();
  });
}

function stopDockerEventWatcher(): void {
  eventsStopping = true;
  eventsStream?.destroy?.();
  eventsStream = null;
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

  const dep = await prisma.deployment.findFirst({
    where: { id: deploymentId, applicationId: app.id }
  });
  if (!dep) {
    throw new Error(`Deployment ${deploymentId} not found`);
  }

  const baseDomain = process.env.SOHWE_BASE_DOMAIN ?? "sohwe.localhost";
  const traefikR = traefikName(app.slug);
  const network = process.env.TRAEFIK_DOCKER_NETWORK ?? "sohwe_proxy";

  /**
   * HTTPS is opt-in via `SOHWE_HTTPS_ENABLED=true` (the operator also has to
   * configure an ACME resolver + websecure entrypoint in Traefik). We also
   * require a real public domain; Let's Encrypt will not issue for `.localhost`.
   */
  const httpsEnabled =
    (process.env.SOHWE_HTTPS_ENABLED ?? "").toLowerCase() === "true";
  const certResolver = process.env.SOHWE_CERT_RESOLVER ?? "letsencrypt";

  const defaultHost = `${app.slug}.${baseDomain}`;
  const hosts: string[] = [defaultHost];
  if (app.domain && app.domain !== defaultHost) hosts.push(app.domain);

  const isPublicDomain = (h: string) =>
    !h.endsWith(".localhost") && !h.endsWith(".local") && h !== "localhost";
  const useTls = httpsEnabled && hosts.some(isPublicDomain);
  const hostRule = hosts.map((h) => `Host(\`${h}\`)`).join(" || ");

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
      await buildAppImage({
        contextDir: repoDir,
        imageTag,
        mode: (app.buildMode as BuildMode) ?? "auto",
        buildCmd: app.buildCmd,
        startCmd: app.startCmd,
        onLogLine: onLog
      });
    }

    await sink.end();
    onLog(`[sohwe] Stopping old containers for this app (if any)...`);
    stopRuntimeLogTail(app.id);
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
      `[sohwe] Starting container (Traefik: ${hostRule}, port ${String(app.port)}, tls=${String(useTls)})...`
    );

    const vols = await prisma.volume.findMany({ where: { applicationId: app.id } });
    for (const v of vols) {
      const vn = appDockerVolumeName(app.id, v.id);
      try {
        await docker.getVolume(vn).inspect();
      } catch {
        await docker.createVolume({
          Name: vn,
          Labels: {
            "sohwe.managed": "true",
            "sohwe.app": app.id,
            "sohwe.volume": v.id
          }
        });
      }
    }

    let envList: string[] = [];
    if (app.envVarsEncrypted) {
      const raw = app.envVarsEncrypted;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const vars = decryptJson(buf);
      envList = toDockerEnvList(vars);
    }

    const binds = vols.map(
      (v) => `${appDockerVolumeName(app.id, v.id)}:${v.mountPath}`
    );

    const containerName =
      `sohwe-${app.slug}`.replace(/[^a-z0-9-]/g, "-").slice(0, 63) || "sohwe-app";

    const port = app.port;
    const labels: Record<string, string> = {
      "traefik.enable": "true",
      "traefik.docker.network": network,
      [`traefik.http.services.${traefikR}.loadbalancer.server.port`]: String(
        port
      ),
      "sohwe.managed": "true",
      "sohwe.app": app.id,
      "sohwe.deployment": deploymentId
    };

    // Always expose an HTTP router. When TLS is enabled, HTTP redirects to HTTPS.
    labels[`traefik.http.routers.${traefikR}.rule`] = hostRule;
    labels[`traefik.http.routers.${traefikR}.entrypoints`] = "web";
    labels[`traefik.http.routers.${traefikR}.service`] = traefikR;

    if (useTls) {
      const secureName = `${traefikR}s`;
      labels[`traefik.http.routers.${secureName}.rule`] = hostRule;
      labels[`traefik.http.routers.${secureName}.entrypoints`] = "websecure";
      labels[`traefik.http.routers.${secureName}.service`] = traefikR;
      labels[`traefik.http.routers.${secureName}.tls`] = "true";
      labels[`traefik.http.routers.${secureName}.tls.certresolver`] =
        certResolver;

      // HTTP → HTTPS redirect middleware, applied to the plain router.
      const mw = `${traefikR}-redirect`;
      labels[`traefik.http.middlewares.${mw}.redirectscheme.scheme`] = "https";
      labels[`traefik.http.middlewares.${mw}.redirectscheme.permanent`] =
        "true";
      labels[`traefik.http.routers.${traefikR}.middlewares`] = mw;
    }

    const c = await docker.createContainer({
      name: containerName,
      Image: imageTag,
      Labels: labels,
      ExposedPorts: { [`${port}/tcp`]: {} },
      Env: envList.length > 0 ? envList : undefined,
      HostConfig: {
        NetworkMode: network,
        RestartPolicy: { Name: "unless-stopped" },
        Binds: binds.length > 0 ? binds : undefined,
        Memory: app.memoryLimitMb
          ? app.memoryLimitMb * 1024 * 1024
          : undefined,
        NanoCpus: app.cpuLimit
          ? Math.round(Number(app.cpuLimit) * 1e9)
          : undefined
      }
    });

    await c.start();
    await startRuntimeLogTail(app.id, c, Math.floor(Date.now() / 1000) - 1);

    const intNetName = appInternalNetworkName(app.id);
    try {
      await docker.createNetwork({
        Name: intNetName,
        Driver: "bridge",
        Internal: true,
        Labels: { "sohwe.managed": "true", "sohwe.app": app.id }
      });
    } catch {
      // already exists
    }
    const internalNet = docker.getNetwork(intNetName);
    await internalNet.connect({ Container: c.id });

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

await startRuntimeLogTailsForRunningContainers().catch((e) => {
  console.error("Failed to attach runtime log tails", e);
});

startStatsCollector();
await startDockerEventWatcher().catch((e) => {
  console.error("Failed to start Docker event watcher", e);
});

let backups: BackupSubsystem | null = null;
try {
  backups = await startBackupSubsystem();
} catch (e) {
  console.error("Failed to start backup subsystem", e);
}

worker.on("failed", (job, err) => {
  console.error("Job failed", job?.id, err);
});
worker.on("error", (err) => {
  console.error("Worker error", err);
});

const shutdown = async () => {
  stopStatsCollector();
  stopDockerEventWatcher();
  for (const appId of runtimeLogTails.keys()) stopRuntimeLogTail(appId);
  await worker.close();
  if (backups) await backups.close();
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
