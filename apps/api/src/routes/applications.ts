import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import {
  createQueue,
  getRedisUrl,
  logChannelName
} from "@sohwe/queue";
import {
  CreateApplicationSchema,
  RollbackBodySchema
} from "@sohwe/types";
import Docker from "dockerode";
import IORedis from "ioredis";
import { z } from "zod";
import { authPreHandler } from "../session";

const docker = new Docker();
const deployQueue = createQueue();

const IdParam = z.object({ id: z.string().uuid() });
const DepParam = z.object({ deploymentId: z.string().uuid() });

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function registerApplicationRoutes(app: FastifyInstance) {
  app.post(
    "/api/applications",
    {
      preHandler: [authPreHandler],
      schema: { body: CreateApplicationSchema }
    },
    async (req, _reply) => {
      const u = req.user!;
      const body = CreateApplicationSchema.parse(req.body);
      return prisma.application.create({
        data: {
          name: body.name,
          slug: body.slug,
          gitRepo: body.gitRepo,
          gitBranch: body.gitBranch,
          port: body.port,
          buildMode: "dockerfile",
          buildCmd: body.buildCmd ?? null,
          startCmd: body.startCmd ?? null,
          domain: body.domain ?? null,
          organizationId: u.organizationId
        }
      });
    }
  );

  app.get(
    "/api/applications",
    { preHandler: [authPreHandler] },
    async (req, _reply) => {
      const u = req.user!;
      return prisma.application.findMany({
        where: { organizationId: u.organizationId },
        orderBy: { createdAt: "desc" },
        include: {
          deployments: { orderBy: { createdAt: "desc" }, take: 20 }
        }
      });
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
        include: {
          deployments: { orderBy: { createdAt: "desc" }, take: 30 }
        }
      });
      if (!a) return reply.notFound();
      return a;
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
        where: { id, organizationId: u.organizationId }
      });
      if (!a) return reply.notFound();
      const list = await docker.listContainers({
        all: true,
        filters: { label: [`sohwe.app=${a.id}`] }
      });
      for (const c of list) {
        const d = docker.getContainer(c.Id);
        await d.stop({ t: 10 }).catch(() => {});
        await d.remove().catch(() => {});
      }
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
        include: { application: true }
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
