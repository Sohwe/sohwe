import { Resolver } from "node:dns/promises";
import type { FastifyInstance } from "fastify";
import { prisma } from "@sohwe/db";
import { decryptToUtf8, encryptUtf8 } from "@sohwe/crypto";
import {
  DnsApiProviderSchema,
  DnsInspectQuerySchema,
  SetDnsCredentialSchema,
  type DnsApplyResult,
  type DnsInspection
} from "@sohwe/types";
import { z } from "zod";
import { recordAudit } from "../audit";
import { requireRole } from "../rbac";
import type { ApiConfig } from "../env";
import { findZoneNameservers, matchProvider, type NsLookup } from "../dns/providers";
import {
  CloudflareApiError,
  findCloudflareZone,
  upsertCloudflareARecord,
  verifyCloudflareToken
} from "../dns/cloudflare";

// Custom domain DNS assist (Phase 8): where does a domain's DNS live, does it
// point here yet, and — when an org-level Cloudflare token is configured — set
// the record with one click.
//
// Role floors: inspection is member (an NS lookup on a domain the member can
// already see exposes nothing secret); everything touching the provider
// credential is admin-and-above, consistent with the other integrations. The
// token itself is encrypted at rest and never returned or logged.

const IdParam = z.object({ id: z.string().uuid() });
const ProviderParam = z.object({ provider: DnsApiProviderSchema });

/** DNS/HTTP dependencies, injectable so route tests never touch the network. */
export type DnsRouteDeps = {
  resolveNs?: NsLookup;
  resolve4?: (host: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
};

/**
 * IPv4 a custom domain must point at, discovered from the apps base domain:
 * its own A record first, then a wildcard probe label — hosts commonly publish
 * only `*.<base-domain>`. Null when neither resolves (e.g. local dev).
 */
async function resolveExpectedIp(
  baseDomain: string,
  resolve4: (host: string) => Promise<string[]>
): Promise<string | null> {
  for (const host of [baseDomain, `sohwe-dns-probe.${baseDomain}`]) {
    try {
      const addrs = await resolve4(host);
      if (addrs.length > 0 && addrs[0]) return addrs[0];
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export async function registerDnsRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  deps: DnsRouteDeps = {}
) {
  // One resolver per server instance; short timeout so a dead upstream DNS
  // turns into a degraded inspection, not a hung request.
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  const resolveNs: NsLookup =
    deps.resolveNs ?? ((host) => resolver.resolveNs(host));
  const resolve4 =
    deps.resolve4 ?? ((host: string) => resolver.resolve4(host));
  const fetchImpl = deps.fetchImpl ?? fetch;

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

      const zoneInfo = await findZoneNameservers(domain, resolveNs);
      const provider = zoneInfo
        ? matchProvider(zoneInfo.nameservers, zoneInfo.zone)
        : null;

      const expectedIp = await resolveExpectedIp(config.baseDomain, resolve4);

      let resolvedIps: string[] = [];
      try {
        resolvedIps = await resolve4(domain);
      } catch {
        // No A records yet — reported as "unresolved" below.
      }

      const status: DnsInspection["status"] = !expectedIp
        ? "unknown"
        : resolvedIps.length === 0
          ? "unresolved"
          : resolvedIps.includes(expectedIp)
            ? "verified"
            : "mismatch";

      return {
        domain,
        zone: zoneInfo?.zone ?? null,
        nameservers: zoneInfo?.nameservers ?? [],
        provider,
        expectedIp,
        resolvedIps,
        status,
        record: expectedIp
          ? { type: "A", name: domain, value: expectedIp }
          : null
      };
    }
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

      // Reject a broken token now, with Cloudflare's own explanation, instead
      // of storing it and failing at the first apply.
      try {
        await verifyCloudflareToken(token, fetchImpl);
      } catch (err) {
        if (err instanceof CloudflareApiError) {
          return reply.badRequest(err.message);
        }
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

  app.post(
    "/api/applications/:id/dns/apply",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam },
      ...secretOpts
    },
    async (req, reply): Promise<DnsApplyResult | void> => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;

      const a = await prisma.application.findFirst({
        where: { id, organizationId: u.organizationId },
        select: { id: true, slug: true, domain: true }
      });
      if (!a) return reply.notFound();
      if (!a.domain) {
        return reply.badRequest(
          "This app has no custom domain — set one in settings first."
        );
      }

      const credential = await prisma.dnsProviderCredential.findUnique({
        where: {
          organizationId_provider: {
            organizationId: u.organizationId,
            provider: "cloudflare"
          }
        }
      });
      if (!credential) {
        return reply.badRequest(
          "No Cloudflare API token is configured for this organization."
        );
      }

      const expectedIp = await resolveExpectedIp(config.baseDomain, resolve4);
      if (!expectedIp) {
        return reply.badRequest(
          `Could not determine this instance's public IP: neither ${config.baseDomain} ` +
            "nor a wildcard label under it resolves. Point SOHWE_BASE_DOMAIN at this host first."
        );
      }

      const token = decryptToUtf8(Buffer.from(credential.tokenEncrypted));
      try {
        const zone = await findCloudflareZone(token, a.domain, fetchImpl);
        if (!zone) {
          return reply.badRequest(
            `The configured Cloudflare token cannot see a zone containing ${a.domain}. ` +
              "Check the token's zone scope, or that the domain is on Cloudflare at all."
          );
        }
        const result = await upsertCloudflareARecord(
          token,
          zone,
          a.domain,
          expectedIp,
          fetchImpl
        );
        await recordAudit(req, {
          action: "dns.record.apply",
          targetType: "dns",
          targetId: a.id,
          targetLabel: a.domain,
          metadata: {
            provider: "cloudflare",
            zone: zone.name,
            action: result.action,
            recordType: "A"
          }
        });
        return {
          action: result.action,
          zone: zone.name,
          record: { type: "A", name: a.domain, value: expectedIp },
          proxied: result.proxied
        };
      } catch (err) {
        if (err instanceof CloudflareApiError) {
          return reply.badRequest(err.message);
        }
        throw err;
      }
    }
  );
}
