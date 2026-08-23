import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import {
  EnvQuerySchema,
  VariablesPatchSchema,
  VariablesReplaceSchema
} from "@sohwe/types";
import { z } from "zod";
import { envChangeMetadata, recordAudit } from "../audit";
import { requireRole } from "../rbac";
import {
  applyScopedPatch,
  encodeVarBlob,
  maskedScopedListing,
  mergeScoped,
  readVarBlob,
  revealedScopedListing,
  splitScoped,
  unknownRescopeKeys
} from "./variable-store";

const IdParam = z.object({ id: z.string().uuid() });

/*
 * The unified variable surface: one list per application, each entry scoped to
 * `runtime`, `build`, or `both`. It is a view over the same two encrypted
 * columns the older `/env` and `/build-args` routes own — those stay, because
 * datastore bindings and bundle restore write one map without touching the
 * other, and because a scope is only meaningful when you are looking at both.
 *
 * Admin-and-above throughout, masked by default, and silent-logged: the same
 * rules as the two routes it merges, since it can expose either one's values.
 */

/** Both maps for one app, or null when the app is not the caller's. */
async function loadMaps(organizationId: string, id: string) {
  const a = await prisma.application.findFirst({
    where: { id, organizationId },
    select: {
      id: true,
      slug: true,
      envVarsEncrypted: true,
      buildArgsEncrypted: true
    }
  });
  if (!a) return null;
  return {
    app: a,
    env: readVarBlob(a.envVarsEncrypted),
    build: readVarBlob(a.buildArgsEncrypted)
  };
}

export async function registerVariableRoutes(app: FastifyInstance) {
  const varOpts = { logLevel: "silent" as const };

  app.get(
    "/api/applications/:id/variables",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, querystring: EnvQuerySchema },
      ...varOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { reveal } = req.query as z.infer<typeof EnvQuerySchema>;

      let loaded: Awaited<ReturnType<typeof loadMaps>>;
      try {
        loaded = await loadMaps(u.organizationId, id);
      } catch {
        return reply
          .status(500)
          .send({ message: "Failed to read variable configuration" });
      }
      if (!loaded) return reply.notFound();

      const merged = mergeScoped(loaded.env, loaded.build);
      if (!reveal) return maskedScopedListing(merged);

      // Reading plaintext is itself auditable, and the unified read can expose
      // either map — so it is recorded against whichever ones actually hold
      // keys, keeping each surface's existing trail intact.
      const envKeys = Object.keys(loaded.env).sort();
      const buildKeys = Object.keys(loaded.build).sort();
      if (envKeys.length > 0) {
        await recordAudit(req, {
          action: "env.reveal",
          targetType: "env",
          targetId: loaded.app.id,
          targetLabel: loaded.app.slug,
          metadata: { keys: envKeys, totalKeys: envKeys.length, via: "variables" }
        });
      }
      if (buildKeys.length > 0) {
        await recordAudit(req, {
          action: "build_args.reveal",
          targetType: "build_args",
          targetId: loaded.app.id,
          targetLabel: loaded.app.slug,
          metadata: {
            keys: buildKeys,
            totalKeys: buildKeys.length,
            via: "variables"
          }
        });
      }
      return revealedScopedListing(merged);
    }
  );

  /**
   * Write both columns in one update, and audit each map that actually moved.
   * A no-op map produces no audit row: replacing only build variables should
   * not read as an env var change.
   */
  async function persist(
    req: Parameters<typeof recordAudit>[0],
    app: { id: string; slug: string },
    before: { env: Record<string, string>; build: Record<string, string> },
    after: { env: Record<string, string>; build: Record<string, string> },
    mode: "replace" | "patch"
  ) {
    await prisma.application.update({
      where: { id: app.id },
      data: {
        envVarsEncrypted: encodeVarBlob(after.env),
        buildArgsEncrypted: encodeVarBlob(after.build)
      }
    });
    if (mapsDiffer(before.env, after.env)) {
      await recordAudit(req, {
        action: "env.update",
        targetType: "env",
        targetId: app.id,
        targetLabel: app.slug,
        metadata: {
          mode,
          via: "variables",
          ...envChangeMetadata(before.env, after.env)
        }
      });
    }
    if (mapsDiffer(before.build, after.build)) {
      await recordAudit(req, {
        action: "build_args.update",
        targetType: "build_args",
        targetId: app.id,
        targetLabel: app.slug,
        metadata: {
          mode,
          via: "variables",
          ...envChangeMetadata(before.build, after.build)
        }
      });
    }
  }

  app.put(
    "/api/applications/:id/variables",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: VariablesReplaceSchema },
      ...varOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { vars } = VariablesReplaceSchema.parse(req.body);

      const dupe = firstDuplicateKey(vars.map((v) => v.key));
      if (dupe) return reply.badRequest(`Duplicate variable key: ${dupe}`);

      // Both maps are being replaced wholesale; the previous values are read
      // only to describe the change, so an unreadable blob is not fatal here.
      let loaded: Awaited<ReturnType<typeof loadMaps>>;
      try {
        loaded = await loadMaps(u.organizationId, id);
      } catch {
        const a = await prisma.application.findFirst({
          where: { id, organizationId: u.organizationId },
          select: { id: true, slug: true }
        });
        if (!a) return reply.notFound();
        loaded = { app: { ...a, envVarsEncrypted: null, buildArgsEncrypted: null }, env: {}, build: {} };
      }
      if (!loaded) return reply.notFound();

      const after = splitScoped(vars);
      await persist(req, loaded.app, { env: loaded.env, build: loaded.build }, after, "replace");
      return { ok: true, id: loaded.app.id };
    }
  );

  app.patch(
    "/api/applications/:id/variables",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: VariablesPatchSchema },
      ...varOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { set, rescope, unset } = VariablesPatchSchema.parse(req.body);

      if (
        (set == null || set.length === 0) &&
        (rescope == null || rescope.length === 0) &&
        (unset == null || unset.length === 0)
      ) {
        return reply.badRequest("Provide set, rescope, and/or unset");
      }
      const dupe = firstDuplicateKey((set ?? []).map((v) => v.key));
      if (dupe) return reply.badRequest(`Duplicate variable key: ${dupe}`);

      let loaded: Awaited<ReturnType<typeof loadMaps>>;
      try {
        loaded = await loadMaps(u.organizationId, id);
      } catch {
        return reply
          .status(500)
          .send({ message: "Failed to read variable configuration" });
      }
      if (!loaded) return reply.notFound();

      const before = { env: loaded.env, build: loaded.build };
      const missing = unknownRescopeKeys(before.env, before.build, rescope);
      if (missing.length > 0) {
        return reply.badRequest(
          `No such variable: ${missing.join(", ")}`
        );
      }
      const after = applyScopedPatch(before.env, before.build, set, unset, rescope);
      await persist(req, loaded.app, before, after, "patch");
      return { ok: true, id: loaded.app.id };
    }
  );
}

/** Whether a map moved at all — a no-op map must not write an audit row. */
function mapsDiffer(
  before: Record<string, string>,
  after: Record<string, string>
): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) if (before[k] !== after[k]) return true;
  return false;
}

function firstDuplicateKey(keys: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) return k;
    seen.add(k);
  }
  return null;
}
