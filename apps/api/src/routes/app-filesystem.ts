import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import { FsPathQuerySchema } from "@sohwe/types";
import Docker from "dockerode";
import { z } from "zod";
import {
  FsError,
  getRunningAppContainer,
  listContainerPath,
  normalizeContainerPath,
  readContainerFile
} from "../container-fs";
import { authPreHandler } from "../session";

const docker = new Docker();

const IdParam = z.object({ id: z.string().uuid() });

export async function registerAppFilesystemRoutes(app: FastifyInstance) {
  app.get(
    "/api/applications/:id/fs/list",
    {
      preHandler: [authPreHandler],
      schema: { params: IdParam, querystring: FsPathQuerySchema }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { path: rawPath } = req.query as z.infer<typeof FsPathQuerySchema>;

      const application = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!application) return reply.notFound();

      let path: string;
      try {
        path = normalizeContainerPath(rawPath);
      } catch (e) {
        if (e instanceof FsError) {
          return reply.status(e.statusCode).send({ message: e.message });
        }
        throw e;
      }

      const container = await getRunningAppContainer(docker, id);
      if (!container) {
        return reply.status(409).send({
          message:
            "No running container for this application. Deploy it first, then browse files."
        });
      }

      try {
        const entries = await listContainerPath(container, path);
        return { path, entries };
      } catch (e) {
        if (e instanceof FsError) {
          return reply.status(e.statusCode).send({ message: e.message });
        }
        throw e;
      }
    }
  );

  app.get(
    "/api/applications/:id/fs/file",
    {
      preHandler: [authPreHandler],
      schema: { params: IdParam, querystring: FsPathQuerySchema }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { path: rawPath } = req.query as z.infer<typeof FsPathQuerySchema>;

      const application = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!application) return reply.notFound();

      let path: string;
      try {
        path = normalizeContainerPath(rawPath);
      } catch (e) {
        if (e instanceof FsError) {
          return reply.status(e.statusCode).send({ message: e.message });
        }
        throw e;
      }

      const container = await getRunningAppContainer(docker, id);
      if (!container) {
        return reply.status(409).send({
          message:
            "No running container for this application. Deploy it first to read files."
        });
      }

      try {
        const file = await readContainerFile(container, path);
        return { path, ...file };
      } catch (e) {
        if (e instanceof FsError) {
          return reply.status(e.statusCode).send({ message: e.message });
        }
        throw e;
      }
    }
  );
}
