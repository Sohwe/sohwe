import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import {
  appLogChannelName,
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
import Docker from "dockerode";
import IORedis from "ioredis";
import { z } from "zod";
import { defaultApplicationSelect, serializeAppListRow } from "../app-public";
import { getRunningAppContainer } from "../container-fs";
import { authPreHandler } from "../session";

const docker = new Docker();
const deployQueue = createQueue();

const IdParam = z.object({ id: z.string().uuid() });
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
    await docker.getNetwork(netName).remove();
  } catch (e) {
    const err = e as { statusCode?: number };
    if (err?.statusCode !== 404) throw e;
  }
}

export async function registerApplicationRoutes(app: FastifyInstance) {
  const sel20 = defaultApplicationSelect(20);
  const sel30 = defaultApplicationSelect(30);

  app.post(
    "/api/applications",
    {
      preHandler: [authPreHandler],
      schema: { body: CreateApplicationSchema }
    },
    async (req, _reply) => {
      const u = req.user!;
      const body = CreateApplicationSchema.parse(req.body);
      const created = await prisma.application.create({
        data: {
          name: body.name,
          slug: body.slug,
          gitRepo: body.gitRepo,
          gitBranch: body.gitBranch,
          port: body.port,
          buildMode: body.buildMode,
          buildCmd: body.buildCmd ?? null,
          startCmd: body.startCmd ?? null,
          domain: body.domain ?? null,
          organizationId: u.organizationId
        },
        select: sel20
      });
      return serializeAppListRow(created);
    }
  );

  app.patch(
    "/api/applications/:id",
    {
      preHandler: [authPreHandler],
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
      return serializeAppListRow(updated);
    }
  );

  app.get(
    "/api/applications",
    { preHandler: [authPreHandler] },
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
      preHandler: [authPreHandler],
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
      preHandler: [authPreHandler],
      schema: { params: IdParam }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: {
          id: true,
          volumes: { select: { id: true } }
        }
      });
      if (!a) return reply.notFound();
      const volIds = a.volumes.map((v) => v.id);
      await removeDockerForApplication(a.id, volIds);
      await prisma.application.delete({ where: { id: a.id } });
      return { ok: true };
    }
  );

  app.post(
    "/api/applications/:id/deploy",
    {
      preHandler: [authPreHandler],
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
      await deployQueue.add(
        "deploy",
        { deploymentId: d.id, applicationId: a.id },
        { jobId: d.id, removeOnComplete: 200, removeOnFail: 100 }
      );
      return reply.status(202).send({ deployment: { id: d.id, status: d.status } });
    }
  );

  app.post(
    "/api/applications/:id/rollback",
    {
      preHandler: [authPreHandler],
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
        data: { applicationId: a.id, status: "pending" }
      });
      await deployQueue.add(
        "promote",
        {
          deploymentId: d.id,
          applicationId: a.id,
          promoteImageFromDeploymentId: sourceDeploymentId
        },
        { jobId: d.id, removeOnComplete: 200, removeOnFail: 100 }
      );
      return reply
        .status(202)
        .send({ deployment: { id: d.id, status: d.status } });
    }
  );

  app.get(
    "/api/applications/:id/logs",
    {
      preHandler: [authPreHandler],
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
    "/api/deployments/:deploymentId/logs",
    {
      preHandler: [authPreHandler],
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
