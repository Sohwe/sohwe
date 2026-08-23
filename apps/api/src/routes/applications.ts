import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import {
  appLogChannelName,
  appStatsKey,
  createQueue,
  getRedisUrl,
  logChannelName
} from "@sohwe/queue";
import {
  appDockerVolumeName,
  appInternalNetworkName,
  CreateApplicationSchema,
  RollbackBodySchema,
  UpdateApplicationSchema
} from "@sohwe/types";
import { parseGitHubRepoUrl, repoFullName } from "@sohwe/github";
import { loadGitHubApp } from "@sohwe/github/resolve";
import Docker from "dockerode";
import IORedis from "ioredis";
import { z } from "zod";
import { defaultApplicationSelect, serializeAppListRow } from "../app-public";
import { getRunningAppContainer } from "../container-fs";
import { recordAudit } from "../audit";
import { requireRole } from "../rbac";
import { isUniqueViolation } from "../prisma-errors";

const docker = new Docker();

const IdParam = z.object({ id: z.string().uuid() });

function slugInUseMessage(slug: string): string {
  return `An application with the slug "${slug}" already exists in this organization. Slugs must be unique — pick a different one.`;
}
const DepParam = z.object({ deploymentId: z.string().uuid() });

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", reject);
  });
  return Buffer.concat(chunks);
}

function decodeDockerLogBuffer(buf: Buffer): string {
  let offset = 0;
  const chunks: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];
    const hasHeader =
      (streamType === 1 || streamType === 2) &&
      buf[offset + 1] === 0 &&
      buf[offset + 2] === 0 &&
      buf[offset + 3] === 0;

    if (!hasHeader) return buf.toString("utf8");

    const len = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + len;
    if (end > buf.length) return buf.toString("utf8");
    chunks.push(buf.subarray(start, end));
    offset = end;
  }

  if (offset !== buf.length) return buf.toString("utf8");
  return Buffer.concat(chunks).toString("utf8");
}

async function readRecentRuntimeLogs(applicationId: string): Promise<string> {
  const container = await getRunningAppContainer(docker, applicationId);
  if (!container) return "";
  const logs = (await container.logs({
    stdout: true,
    stderr: true,
    timestamps: false,
    tail: 200
  })) as Buffer | NodeJS.ReadableStream;
  const buf = Buffer.isBuffer(logs) ? logs : await collectStream(logs);
  return decodeDockerLogBuffer(buf);
}

/** Stop and remove app containers, named volumes, and the internal per-app network. */
async function removeDockerForApplication(
  appId: string,
  volumeIds: string[]
): Promise<void> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`sohwe.app=${appId}`] }
  });
  for (const c of list) {
    const d = docker.getContainer(c.Id);
    await d.stop({ t: 10 }).catch(() => {});
    await d.remove().catch(() => {});
  }
  for (const vid of volumeIds) {
    const name = appDockerVolumeName(appId, vid);
    try {
      await docker.getVolume(name).remove({ force: true });
    } catch (e) {
      const err = e as { statusCode?: number };
      if (err?.statusCode !== 404) throw e;
    }
  }
  const netName = appInternalNetworkName(appId);
  try {
    const network = docker.getNetwork(netName);
    // A lingering endpoint on a per-app internal network can only be a bound
    // datastore container (Phase 7) — the app's own containers were removed
    // above. Docker refuses to remove a network with active endpoints, so
    // disconnect them first (best-effort; the datastore itself lives on).
    try {
      const info = (await network.inspect()) as {
        Containers?: Record<string, unknown>;
      };
      for (const containerId of Object.keys(info.Containers ?? {})) {
        await network
          .disconnect({ Container: containerId, Force: true })
          .catch(() => {});
      }
    } catch {
      // fall through to remove; a 404 is handled below
    }
    await network.remove();
  } catch (e) {
    const err = e as { statusCode?: number };
    if (err?.statusCode !== 404) throw e;
  }
}

/**
 * Why auto-deploy cannot be turned on for this repo, or null when it can.
 * Enabling it without a GitHub App installed would leave the toggle on and
 * nothing ever deploying, which is worse than refusing.
 */
async function autoDeployBlocker(
  organizationId: string,
  repoName: string | null
): Promise<string | null> {
  if (!repoName) {
    return "Auto-deploy needs a GitHub repository. This app's repo URL is not a GitHub remote.";
  }
  const githubApp = await loadGitHubApp(organizationId).catch(() => null);
  if (!githubApp) {
    return "Connect a GitHub App first (Settings -> Git) to enable auto-deploy.";
  }
  if (!githubApp.installationId) {
    return "Install the GitHub App on your account first to enable auto-deploy.";
  }
  return null;
}

export async function registerApplicationRoutes(app: FastifyInstance) {
  const sel20 = defaultApplicationSelect(20);
  const sel30 = defaultApplicationSelect(30);

  // Redis connections are owned by this server instance, not the module:
  // `onClose` below shuts them down, and a module-level connection would leave
  // every *other* instance built in the same process holding a closed handle.
  // Production builds one server; the route tests build a fresh one per test.
  //
  // They are also opened lazily, on the first request that needs one. Opening
  // eagerly means a server that never deploys still connects and then tears the
  // connection down at close, which races any handshake still in flight.
  let deployQueue: ReturnType<typeof createQueue> | null = null;
  let statsRedis: IORedis | null = null;

  function queue(): ReturnType<typeof createQueue> {
    deployQueue ??= createQueue();
    return deployQueue;
  }

  /** Read-only client for polling the worker's short-TTL stats keys. */
  function stats(): IORedis {
    statsRedis ??= new IORedis(getRedisUrl());
    return statsRedis;
  }

  // Either would otherwise keep the process alive after `app.close()` — which
  // SIGTERM calls, and which a test run needs in order to exit at all.
  app.addHook("onClose", async () => {
    await deployQueue?.close().catch(() => {});
    statsRedis?.disconnect();
  });

  app.post(
    "/api/applications",
    {
      preHandler: [requireRole("admin")],
      schema: { body: CreateApplicationSchema }
    },
    async (req, reply) => {
      const u = req.user!;
      const body = CreateApplicationSchema.parse(req.body);

      // Denormalized so push webhooks resolve with one indexed lookup; null for
      // non-GitHub remotes, which simply never match a delivery.
      const ref = parseGitHubRepoUrl(body.gitRepo);
      const repoName = ref ? repoFullName(ref) : null;

      if (body.autoDeploy) {
        const blocker = await autoDeployBlocker(u.organizationId, repoName);
        if (blocker) return reply.badRequest(blocker);
      }

      // Slugs are unique per organization (they become the app subdomain, the
      // container name, and the Traefik router), so a collision is a normal
      // user mistake, not a server fault. Checked here for the clear message
      // and caught below for the race between the two.
      const slugTaken = await prisma.application.findFirst({
        where: { organizationId: u.organizationId, slug: body.slug },
        select: { id: true }
      });
      if (slugTaken) return reply.conflict(slugInUseMessage(body.slug));

      const created = await prisma.application.create({
        data: {
          name: body.name,
          slug: body.slug,
          gitRepo: body.gitRepo,
          gitBranch: body.gitBranch,
          repoFullName: repoName,
          autoDeploy: body.autoDeploy,
          port: body.port,
          buildMode: body.buildMode,
          buildCmd: body.buildCmd ?? null,
          startCmd: body.startCmd ?? null,
          domain: body.domain ?? null,
          organizationId: u.organizationId
        },
        select: sel20
      }).catch((err: unknown) => {
        if (isUniqueViolation(err, "slug")) return null;
        throw err;
      });
      if (!created) return reply.conflict(slugInUseMessage(body.slug));
      // `sel20` is a widened Prisma.ApplicationSelect, so the row's fields are
      // not statically known here; the id is read back through a narrow view.
      const { id: createdId } = created as unknown as { id: string };
      await recordAudit(req, {
        action: "application.create",
        targetType: "application",
        targetId: createdId,
        targetLabel: body.slug,
        metadata: {
          gitRepo: body.gitRepo,
          gitBranch: body.gitBranch,
          buildMode: body.buildMode,
          autoDeploy: body.autoDeploy
        }
      });
      return serializeAppListRow(created);
    }
  );

  app.patch(
    "/api/applications/:id",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: UpdateApplicationSchema }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const body = UpdateApplicationSchema.parse(req.body);

      const existing = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!existing) return reply.notFound();

      const data: Record<string, unknown> = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.gitBranch !== undefined) data.gitBranch = body.gitBranch;
      if (body.port !== undefined) data.port = body.port;
      if (body.buildMode !== undefined) data.buildMode = body.buildMode;
      if (body.buildCmd !== undefined) {
        data.buildCmd = body.buildCmd ? body.buildCmd : null;
      }
      if (body.startCmd !== undefined) {
        data.startCmd = body.startCmd ? body.startCmd : null;
      }
      if (body.domain !== undefined) {
        data.domain = body.domain ? body.domain : null;
      }
      if (body.memoryLimitMb !== undefined) {
        data.memoryLimitMb = body.memoryLimitMb;
      }
      if (body.cpuLimit !== undefined) {
        data.cpuLimit = body.cpuLimit;
      }
      if (body.autoDeploy !== undefined) {
        if (body.autoDeploy) {
          const blocker = await autoDeployBlocker(
            u.organizationId,
            existing.repoFullName
          );
          if (blocker) return reply.badRequest(blocker);
        }
        data.autoDeploy = body.autoDeploy;
      }

      if (Object.keys(data).length === 0) {
        const cur = await prisma.application.findFirst({
          where: { id, organizationId: u.organizationId },
          select: sel30
        });
        if (!cur) return reply.notFound();
        return serializeAppListRow(cur);
      }

      const updated = await prisma.application.update({
        where: { id },
        data,
        select: sel30
      });
      // Field names only — an app's settings are not secret, but keeping the
      // trail to keys matches how env changes are recorded.
      await recordAudit(req, {
        action: "application.update",
        targetType: "application",
        targetId: existing.id,
        targetLabel: existing.slug,
        metadata: { fields: Object.keys(data).sort() }
      });
      return serializeAppListRow(updated);
    }
  );

  app.get(
    "/api/applications",
    { preHandler: [requireRole("member")] },
    async (req, _reply) => {
      const u = req.user!;
      const rows = await prisma.application.findMany({
        where: { organizationId: u.organizationId },
        orderBy: { createdAt: "desc" },
        select: sel20
      });
      return rows.map(serializeAppListRow);
    }
  );

  app.get(
    "/api/applications/:id",
    {
      preHandler: [requireRole("member")],
      schema: { params: IdParam }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: sel30
      });
      if (!a) return reply.notFound();
      return serializeAppListRow(a);
    }
  );

  app.delete(
    "/api/applications/:id",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: {
          id: true,
          slug: true,
          volumes: { select: { id: true } }
        }
      });
      if (!a) return reply.notFound();
      const volIds = a.volumes.map((v) => v.id);
      await removeDockerForApplication(a.id, volIds);
      await prisma.application.delete({ where: { id: a.id } });
      await recordAudit(req, {
        action: "application.delete",
        targetType: "application",
        targetId: a.id,
        targetLabel: a.slug,
        metadata: { volumesRemoved: volIds.length }
      });
      return { ok: true };
    }
  );

  // Deploy and rollback stay open to members: operating existing apps is the
  // point of the member role. Creating and reconfiguring them is not.
  app.post(
    "/api/applications/:id/deploy",
    {
      preHandler: [requireRole("member")],
      schema: { params: IdParam }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!a) return reply.notFound();
      const d = await prisma.deployment.create({
        data: { applicationId: a.id, status: "pending" }
      });
      await queue().add(
        "deploy",
        { deploymentId: d.id, applicationId: a.id },
        { jobId: d.id, removeOnComplete: 200, removeOnFail: 100 }
      );
      await recordAudit(req, {
        action: "deployment.deploy",
        targetType: "deployment",
        targetId: d.id,
        targetLabel: a.slug,
        metadata: { applicationId: a.id, branch: a.gitBranch }
      });
      return reply.status(202).send({ deployment: { id: d.id, status: d.status } });
    }
  );

  app.post(
    "/api/applications/:id/rollback",
    {
      preHandler: [requireRole("member")],
      schema: { params: IdParam, body: RollbackBodySchema }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { sourceDeploymentId } = RollbackBodySchema.parse(req.body);
      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!a) return reply.notFound();
      const source = await prisma.deployment.findFirst({
        where: {
          id: sourceDeploymentId,
          applicationId: a.id,
          status: "success"
        }
      });
      if (!source?.imageTag) {
        return reply.badRequest("Source deployment is not a successful build");
      }
      const d = await prisma.deployment.create({
        data: { applicationId: a.id, status: "pending", trigger: "rollback" }
      });
      await queue().add(
        "promote",
        {
          deploymentId: d.id,
          applicationId: a.id,
          promoteImageFromDeploymentId: sourceDeploymentId
        },
        { jobId: d.id, removeOnComplete: 200, removeOnFail: 100 }
      );
      await recordAudit(req, {
        action: "deployment.rollback",
        targetType: "deployment",
        targetId: d.id,
        targetLabel: a.slug,
        metadata: {
          applicationId: a.id,
          sourceDeploymentId,
          commitSha: source.commitSha
        }
      });
      return reply
        .status(202)
        .send({ deployment: { id: d.id, status: d.status } });
    }
  );

  app.get(
    "/api/applications/:id/logs",
    {
      preHandler: [requireRole("member")],
      schema: { params: IdParam }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true }
      });
      if (!a) return reply.notFound();

      const channel = appLogChannelName(id);
      const sub = new IORedis(getRedisUrl());
      const existing = await readRecentRuntimeLogs(id).catch(() => "");

      reply.hijack();
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      (reply as { raw: { flushHeaders?(): void } }).raw.flushHeaders?.();
      reply.raw.write(sseData({ type: "replay", text: existing }));

      await sub.subscribe(channel);
      const onMessage = (_ch: string, message: string) => {
        reply.raw.write(sseData({ type: "line", line: message }));
      };
      sub.on("message", onMessage);

      const end = () => {
        sub.off("message", onMessage);
        void sub.unsubscribe(channel).catch(() => {});
        void sub.quit().catch(() => {});
        try {
          reply.raw.end();
        } catch {
          // ignore
        }
      };
      req.raw.on("close", end);
    }
  );

  app.get(
    "/api/applications/:id/stats",
    {
      preHandler: [requireRole("member")],
      schema: { params: IdParam },
      logLevel: "silent"
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true }
      });
      if (!a) return reply.notFound();

      const raw = await stats().get(appStatsKey(id)).catch(() => null);
      if (!raw) return { running: false };
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return { running: false };
      }
    }
  );

  app.get(
    "/api/deployments/:deploymentId/logs",
    {
      preHandler: [requireRole("member")],
      schema: { params: DepParam }
    },
    async (req, reply) => {
      const u = req.user!;
      const { deploymentId } = req.params as z.infer<typeof DepParam>;
      const dep = await prisma.deployment.findFirst({
        where: { id: deploymentId },
        include: {
          application: { select: { id: true, organizationId: true } }
        }
      });
      if (!dep || dep.application.organizationId !== u.organizationId) {
        return reply.notFound();
      }

      const channel = logChannelName(deploymentId);
      const sub = new IORedis(getRedisUrl());
      const existing = dep.buildLogs ?? "";

      reply.hijack();
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      (reply as { raw: { flushHeaders?(): void } }).raw.flushHeaders?.();
      reply.raw.write(sseData({ type: "replay", text: existing }));

      await sub.subscribe(channel);
      const onMessage = (_ch: string, message: string) => {
        reply.raw.write(sseData({ type: "line", line: message }));
      };
      sub.on("message", onMessage);

      const end = () => {
        sub.off("message", onMessage);
        void sub.unsubscribe(channel).catch(() => {});
        void sub.quit().catch(() => {});
        try {
          reply.raw.end();
        } catch {
          // ignore
        }
      };
      req.raw.on("close", end);
    }
  );
}
