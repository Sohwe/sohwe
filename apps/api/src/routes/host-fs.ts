import type { FastifyInstance } from "fastify";
import { FsPathQuerySchema } from "@sohwe/types";
import type { z } from "zod";
import { recordAudit } from "../audit";
import { FsError } from "../container-fs";
import type { ApiConfig } from "../env";
import { listHostPath, readHostFile, resolveHostPath } from "../host-fs";
import { requireRole } from "../rbac";

// Instance *host* filesystem browser (distinct from the per-app container
// browser). Admin-and-above like every secret-adjacent read surface, and off
// entirely unless the operator sets SOHWE_HOST_FS_ALLOWLIST. Unlike the
// container browser, every successful list and read is audited — this is the
// operator's machine, and the trail should show exactly who looked at what.

export async function registerHostFsRoutes(
  app: FastifyInstance,
  config: ApiConfig
) {
  const roots = config.hostFsRoots;
  const enabled = roots.length > 0;

  // Feature discovery for the dashboard: enabled flag plus the browsable roots.
  // The allowlist itself is operator config, not a secret.
  app.get(
    "/api/host-fs",
    { preHandler: [requireRole("admin")] },
    async () => ({ enabled, roots })
  );

  app.get(
    "/api/host-fs/list",
    {
      preHandler: [requireRole("admin")],
      schema: { querystring: FsPathQuerySchema }
    },
    async (req, reply) => {
      if (!enabled) {
        return reply.forbidden(
          "The host file browser is not enabled on this instance. Set SOHWE_HOST_FS_ALLOWLIST to turn it on."
        );
      }
      const { path: rawPath } = req.query as z.infer<typeof FsPathQuerySchema>;
      try {
        const { path, realPath } = await resolveHostPath(rawPath, roots);
        const entries = await listHostPath(realPath);
        await recordAudit(req, {
          action: "host_fs.list",
          targetType: "host_fs",
          targetLabel: path,
          metadata: { entryCount: entries.length }
        });
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
    "/api/host-fs/file",
    {
      preHandler: [requireRole("admin")],
      schema: { querystring: FsPathQuerySchema }
    },
    async (req, reply) => {
      if (!enabled) {
        return reply.forbidden(
          "The host file browser is not enabled on this instance. Set SOHWE_HOST_FS_ALLOWLIST to turn it on."
        );
      }
      const { path: rawPath } = req.query as z.infer<typeof FsPathQuerySchema>;
      try {
        const { path, realPath } = await resolveHostPath(rawPath, roots);
        const file = await readHostFile(realPath);
        await recordAudit(req, {
          action: "host_fs.read",
          targetType: "host_fs",
          targetLabel: path,
          metadata: { size: file.size, truncated: file.truncated }
        });
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
