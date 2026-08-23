import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import { encryptUtf8 } from "@sohwe/crypto";
import {
  DnsApiProviderSchema,
  DnsInspectQuerySchema,
  SetDnsCredentialSchema,
  type DnsInspection
} from "@sohwe/types";
import { z } from "zod";
import { recordAudit } from "../audit";
import { requireRole } from "../rbac";
import type { ApiConfig } from "../env";
import { DnsApiError } from "../dns/driver";
import { getDnsDriver, listDnsDrivers } from "../dns/drivers";
import { inspectDomain, type DnsLookups } from "../dns/inspect";

// Instance-level DNS plumbing: ad-hoc domain inspection, and the per-provider
// API credentials that let Sohwe write records. Everything about a *specific*
// app's domains lives in `domains.ts`.
//
// Role floors: inspection is member (an NS lookup on a hostname exposes
// nothing secret); everything touching a provider credential is admin, in line
// with the other integrations. Tokens are encrypted at rest and never returned
// or logged.

const ProviderParam = z.object({ provider: DnsApiProviderSchema });

export async function registerDnsRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  lookups: DnsLookups,
  fetchImpl: typeof fetch = fetch
) {
  // Routes that carry the provider token never log bodies.
  const secretOpts = { logLevel: "silent" as const };

  app.get(
    "/api/dns/inspect",
    {
      preHandler: [requireRole("member")],
      schema: { querystring: DnsInspectQuerySchema }
    },
    async (req): Promise<DnsInspection> => {
      const { domain } = req.query as z.infer<typeof DnsInspectQuerySchema>;
      return inspectDomain(domain, config.baseDomain, lookups, config.publicIp);
    }
  );

  /**
   * Which providers Sohwe can write records through, and where to get a token
   * for each. Public shape only — no credential state, so it needs no more
   * than the member floor the rest of the DNS reads use.
   */
  app.get(
    "/api/dns/providers",
    { preHandler: [requireRole("member")] },
    async () => ({
      providers: listDnsDrivers().map((d) => ({
        id: d.id,
        label: d.label,
        tokenUrl: d.tokenHelp.url,
        tokenScope: d.tokenHelp.scope
      }))
    })
  );

  app.get(
    "/api/dns/credentials",
    { preHandler: [requireRole("admin")] },
    async (req) => {
      const u = req.user!;
      const rows = await prisma.dnsProviderCredential.findMany({
        where: { organizationId: u.organizationId },
        select: { provider: true, createdAt: true, updatedAt: true },
        orderBy: { provider: "asc" }
      });
      return { credentials: rows };
    }
  );

  app.put(
    "/api/dns/credentials/:provider",
    {
      preHandler: [requireRole("admin")],
      schema: { params: ProviderParam, body: SetDnsCredentialSchema },
      ...secretOpts
    },
    async (req, reply) => {
      const u = req.user!;
      const { provider } = req.params as z.infer<typeof ProviderParam>;
      const { token } = SetDnsCredentialSchema.parse(req.body);

      // Reject a broken token now, with the provider's own explanation, instead
      // of storing it and failing at the first apply.
      try {
        await getDnsDriver(provider).verifyToken(token, fetchImpl);
      } catch (err) {
        if (err instanceof DnsApiError) return reply.badRequest(err.message);
        throw err;
      }

      const tokenEncrypted = encryptUtf8(token);
      await prisma.dnsProviderCredential.upsert({
        where: {
          organizationId_provider: {
            organizationId: u.organizationId,
            provider
          }
        },
        create: { organizationId: u.organizationId, provider, tokenEncrypted },
        update: { tokenEncrypted }
      });

      await recordAudit(req, {
        action: "dns.credentials.set",
        targetType: "dns",
        targetLabel: provider,
        metadata: { provider }
      });
      return { ok: true, provider };
    }
  );

  app.delete(
    "/api/dns/credentials/:provider",
    {
      preHandler: [requireRole("admin")],
      schema: { params: ProviderParam }
    },
    async (req, reply) => {
      const u = req.user!;
      const { provider } = req.params as z.infer<typeof ProviderParam>;
      const { count } = await prisma.dnsProviderCredential.deleteMany({
        where: { organizationId: u.organizationId, provider }
      });
      if (count === 0) return reply.notFound();
      await recordAudit(req, {
        action: "dns.credentials.delete",
        targetType: "dns",
        targetLabel: provider,
        metadata: { provider }
      });
      return { ok: true };
    }
  );
}
