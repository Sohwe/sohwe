import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppDirectorySchema } from "@sohwe/types";
import { requireRole } from "../rbac";
import { inspectRepository, listRepositoryBranches } from "../repository-inspection";

const InspectRequest = z.object({
  gitRepo: z.string().url().max(2048),
  branch: z.string().trim().min(1).max(255),
  directory: AppDirectorySchema.optional()
});
const BranchRequest = z.object({ gitRepo: z.string().url().max(2048) });

export async function registerRepositoryInspectionRoutes(app: FastifyInstance) {
  app.post("/api/repositories/branches", {
    preHandler: [requireRole("admin")],
    schema: { body: BranchRequest },
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    logLevel: "silent"
  }, async (req, reply) => {
    try {
      return await listRepositoryBranches(req.user!.organizationId, BranchRequest.parse(req.body).gitRepo);
    } catch {
      return reply.badRequest("Could not list branches. Check repository access or enter a branch manually.");
    }
  });

  app.post("/api/repositories/inspect", {
    preHandler: [requireRole("admin")],
    schema: { body: InspectRequest },
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    logLevel: "silent"
  }, async (req, reply) => {
    const body = InspectRequest.parse(req.body);
    try {
      return await inspectRepository(req.user!.organizationId, body.gitRepo, body.branch, body.directory);
    } catch (error) {
      // Git may print tokenized remotes. Never serialize or log its error.
      const message = error instanceof Error && /^(Use an HTTPS|Enter a valid branch|App directory must)/.test(error.message)
        ? error.message : "Could not inspect this repository and branch. Check access and the branch name, then retry.";
      return reply.badRequest(message);
    }
  });
}
