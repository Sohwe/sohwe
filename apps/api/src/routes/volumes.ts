import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import { appDockerVolumeName, VolumeCreateSchema } from "@sohwe/types";
import Docker from "dockerode";
import { z } from "zod";
import { serializeVolume } from "../app-public";
import { authPreHandler } from "../session";

const docker = new Docker();

const IdParam = z.object({ id: z.string().uuid() });
const VolIdParam = z.object({
  id: z.string().uuid(),
  volumeId: z.string().uuid()
});

export async function registerVolumeRoutes(app: FastifyInstance) {
  app.get(
    "/api/applications/:id/volumes",
    { preHandler: [authPreHandler], schema: { params: IdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true }
      });
      if (!a) return reply.notFound();
      const rows = await prisma.volume.findMany({
        where: { applicationId: id },
        orderBy: { createdAt: "asc" }
      });
      return { volumes: rows.map(serializeVolume) };
    }
  );

  app.post(
    "/api/applications/:id/volumes",
    {
      preHandler: [authPreHandler],
      schema: { params: IdParam, body: VolumeCreateSchema }
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const body = VolumeCreateSchema.parse(req.body);

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!a) return reply.notFound();

      try {
        const row = await prisma.volume.create({
          data: {
            applicationId: id,
            mountPath: body.mountPath,
            sizeBytes: body.sizeBytes != null ? BigInt(body.sizeBytes) : null
          }
        });
        return reply.status(201).send(serializeVolume(row));
      } catch (e) {
        const code =
          e && typeof e === "object" && "code" in e ? String(e.code) : "";
        if (code === "P2002") {
          return reply
            .status(409)
            .send({ message: "A volume is already configured for that path" });
        }
        throw e;
      }
    }
  );

  app.delete(
    "/api/applications/:id/volumes/:volumeId",
    { preHandler: [authPreHandler], schema: { params: VolIdParam } },
    async (req, reply) => {
      const u = req.user!;
      const { id, volumeId } = req.params as z.infer<typeof VolIdParam>;

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId }
      });
      if (!a) return reply.notFound();

      const row = await prisma.volume.findFirst({
        where: { id: volumeId, applicationId: id }
      });
      if (!row) return reply.notFound();

      const vName = appDockerVolumeName(id, row.id);
      try {
        const dv = docker.getVolume(vName);
        await dv.remove({ force: true });
      } catch (e) {
        const err = e as { statusCode?: number };
        if (err?.statusCode === 404) {
          // Orphaned DB row: continue
        } else if (err?.statusCode === 409) {
          return reply.status(409).send({
            message:
              "Volume is still in use. Stop the app’s container (delete the app, or we may add a stop action later), then try again."
          });
        } else {
          throw e;
        }
      }

      await prisma.volume.delete({ where: { id: row.id } });
      return { ok: true };
    }
  );
}
