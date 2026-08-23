import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@sohwe/db";
import { decryptToUtf8 } from "@sohwe/crypto";
import {
  CreateDomainSchema,
  DNS_API_PROVIDERS,
  type DnsApiProvider,
  type DnsApplyResult,
  type DnsInspection,
  type DomainRow,
  type DomainVerifyResult
} from "@sohwe/types";
import { z } from "zod";
import { recordAudit } from "../audit";
import { requireRole } from "../rbac";
import type { ApiConfig } from "../env";
import { isUniqueViolation } from "../prisma-errors";
import { DnsApiError } from "../dns/driver";
import { getDnsDriver } from "../dns/drivers";
import { inspectDomain, resolveExpectedIp, type DnsLookups } from "../dns/inspect";

/**
 * Custom domains: the hostnames an app answers on beyond its generated
 * `<slug>.<base-domain>` subdomain.
 *
 * Adding one is three steps that used to be spread across a settings form, a
 * DNS panel, and the operator's registrar: claim the hostname here, check that
 * it points at this instance, and — where the DNS host has an API and a token
 * is configured — write the record without leaving the dashboard.
 *
 * Role floors: reading and verifying are `member` (an NS lookup on a hostname a
 * member can already see exposes nothing), while anything that changes routing
 * or touches a provider credential is `admin`. Claiming a hostname decides
 * where traffic goes, which is not a member's call.
 */

const IdParam = z.object({ id: z.string().uuid() });
const DomainParams = IdParam.extend({ domainId: z.string().uuid() });

type DomainRecord = {
  id: string;
  applicationId: string;
  hostname: string;
  isPrimary: boolean;
  lastStatus: string | null;
  lastCheckedAt: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
};

const domainSelect = {
  id: true,
  applicationId: true,
  hostname: true,
  isPrimary: true,
  lastStatus: true,
  lastCheckedAt: true,
  verifiedAt: true,
  createdAt: true
} satisfies Prisma.DomainSelect;

/** Primary first, then oldest — the order the Traefik rule and the UI use. */
const domainOrder: Prisma.DomainOrderByWithRelationInput[] = [
  { isPrimary: "desc" },
  { createdAt: "asc" }
];

function serializeDomain(d: DomainRecord): DomainRow {
  return {
    id: d.id,
    applicationId: d.applicationId,
    hostname: d.hostname,
    isPrimary: d.isPrimary,
    // Written only by this module, always from a `DnsInspectionStatus`.
    lastStatus: d.lastStatus as DomainRow["lastStatus"],
    lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
    verifiedAt: d.verifiedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString()
  };
}

export type DomainRouteDeps = {
  lookups?: Partial<DnsLookups>;
  fetchImpl?: typeof fetch;
};

export async function registerDomainRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  lookups: DnsLookups,
  fetchImpl: typeof fetch = fetch
) {
  /** Load an app in the caller's org, or null. Every route scopes by org. */
  async function loadApp(organizationId: string, id: string) {
    return prisma.application.findFirst({
      where: { id, organizationId },
      select: { id: true, slug: true, name: true }
    });
  }

  /**
   * Persist the outcome of a DNS check on a domain row. `verifiedAt` only ever
   * moves forward: a transient resolver failure should not erase the fact that
   * the domain was once seen pointing here.
   */
  async function recordCheck(
    domainId: string,
    inspection: DnsInspection
  ): Promise<DomainRecord> {
    return prisma.domain.update({
      where: { id: domainId },
      data: {
        lastStatus: inspection.status,
        lastCheckedAt: new Date(),
        ...(inspection.status === "verified" ? { verifiedAt: new Date() } : {})
      },
      select: domainSelect
    });
  }

  app.get(
    "/api/applications/:id/domains",
    { preHandler: [requireRole("member")], schema: { params: IdParam } },
    async (req, reply): Promise<{ domains: DomainRow[] } | void> => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const a = await loadApp(u.organizationId, id);
      if (!a) return reply.notFound();

      const rows = await prisma.domain.findMany({
        where: { applicationId: a.id },
        orderBy: domainOrder,
        select: domainSelect
      });
      return { domains: rows.map(serializeDomain) };
    }
  );

  app.post(
    "/api/applications/:id/domains",
    {
      preHandler: [requireRole("admin")],
      schema: { params: IdParam, body: CreateDomainSchema }
    },
    async (req, reply): Promise<DomainVerifyResult | void> => {
      const u = req.user!;
      const { id } = req.params as z.infer<typeof IdParam>;
      const { hostname, primary } = CreateDomainSchema.parse(req.body);

      const a = await loadApp(u.organizationId, id);
      if (!a) return reply.notFound();

      // A hostname under the apps base domain that matches some app's slug is
      // already generated for that app; claiming it by hand would put two
      // conflicting `Host()` rules on the same name and cross-route traffic.
      const generatedFor = await generatedHostOwner(
        hostname,
        config.baseDomain,
        u.organizationId
      );
      if (generatedFor) {
        return reply.badRequest(
          generatedFor.id === a.id
            ? `${hostname} is this app's built-in address — it is served automatically and does not need to be added.`
            : `${hostname} is the built-in address of the app "${generatedFor.name}". Pick a different hostname.`
        );
      }

      const existingCount = await prisma.domain.count({
        where: { applicationId: a.id }
      });
      // The first domain an app gets is its primary; there is nothing to choose
      // between yet, and an app whose only domain was non-primary would show no
      // custom URL anywhere in the dashboard.
      const makePrimary = primary || existingCount === 0;

      let created: DomainRecord;
      try {
        created = await prisma.$transaction(async (tx) => {
          if (makePrimary) {
            await tx.domain.updateMany({
              where: { applicationId: a.id, isPrimary: true },
              data: { isPrimary: false }
            });
          }
          return tx.domain.create({
            data: { applicationId: a.id, hostname, isPrimary: makePrimary },
            select: domainSelect
          });
        });
      } catch (err) {
        if (isUniqueViolation(err, "hostname")) {
          // Deliberately does not say *which* app holds it: that may be another
          // organization on a shared instance.
          return reply.conflict(
            `${hostname} is already attached to an application on this instance.`
          );
        }
        throw err;
      }

      await recordAudit(req, {
        action: "domain.create",
        targetType: "domain",
        targetId: created.id,
        targetLabel: hostname,
        metadata: { applicationId: a.id, appSlug: a.slug, primary: makePrimary }
      });

      // Check immediately: the whole point of adding a domain here is to be
      // told, in the same breath, what DNS record it still needs.
      const dns = await inspectDomain(hostname, config.baseDomain, lookups);
      const domain = await recordCheck(created.id, dns);
      return { domain: serializeDomain(domain), dns };
    }
  );

  app.post(
    "/api/applications/:id/domains/:domainId/verify",
    {
      preHandler: [requireRole("member")],
      schema: { params: DomainParams }
    },
    async (req, reply): Promise<DomainVerifyResult | void> => {
      const u = req.user!;
      const { id, domainId } = req.params as z.infer<typeof DomainParams>;

      const existing = await prisma.domain.findFirst({
        where: { id: domainId, application: { id, organizationId: u.organizationId } },
        select: domainSelect
      });
      if (!existing) return reply.notFound();

      const dns = await inspectDomain(existing.hostname, config.baseDomain, lookups);
      const domain = await recordCheck(existing.id, dns);
      return { domain: serializeDomain(domain), dns };
    }
  );

  app.post(
    "/api/applications/:id/domains/:domainId/primary",
    {
      preHandler: [requireRole("admin")],
      schema: { params: DomainParams }
    },
    async (req, reply): Promise<{ domains: DomainRow[] } | void> => {
      const u = req.user!;
      const { id, domainId } = req.params as z.infer<typeof DomainParams>;

      const existing = await prisma.domain.findFirst({
        where: { id: domainId, application: { id, organizationId: u.organizationId } },
        select: domainSelect
      });
      if (!existing) return reply.notFound();

      const rows = await prisma.$transaction(async (tx) => {
        await tx.domain.updateMany({
          where: { applicationId: existing.applicationId, isPrimary: true },
          data: { isPrimary: false }
        });
        await tx.domain.update({
          where: { id: existing.id },
          data: { isPrimary: true }
        });
        return tx.domain.findMany({
          where: { applicationId: existing.applicationId },
          orderBy: domainOrder,
          select: domainSelect
        });
      });

      await recordAudit(req, {
        action: "domain.primary",
        targetType: "domain",
        targetId: existing.id,
        targetLabel: existing.hostname,
        metadata: { applicationId: existing.applicationId }
      });
      return { domains: rows.map(serializeDomain) };
    }
  );

  app.delete(
    "/api/applications/:id/domains/:domainId",
    {
      preHandler: [requireRole("admin")],
      schema: { params: DomainParams }
    },
    async (req, reply): Promise<{ ok: true; domains: DomainRow[] } | void> => {
      const u = req.user!;
      const { id, domainId } = req.params as z.infer<typeof DomainParams>;

      const existing = await prisma.domain.findFirst({
        where: { id: domainId, application: { id, organizationId: u.organizationId } },
        select: domainSelect
      });
      if (!existing) return reply.notFound();

      const rows = await prisma.$transaction(async (tx) => {
        await tx.domain.delete({ where: { id: existing.id } });
        const remaining = await tx.domain.findMany({
          where: { applicationId: existing.applicationId },
          orderBy: { createdAt: "asc" },
          select: domainSelect
        });
        // Removing the primary leaves the app with no headline URL, so the
        // oldest survivor takes over rather than the app silently losing one.
        const first = remaining[0];
        if (existing.isPrimary && first) {
          await tx.domain.update({
            where: { id: first.id },
            data: { isPrimary: true }
          });
          first.isPrimary = true;
        }
        return remaining;
      });

      await recordAudit(req, {
        action: "domain.delete",
        targetType: "domain",
        targetId: existing.id,
        targetLabel: existing.hostname,
        metadata: { applicationId: existing.applicationId }
      });
      // The container keeps answering on the removed host until the next
      // deploy rewrites its Traefik labels; the dashboard says so.
      return { ok: true, domains: rows.map(serializeDomain) };
    }
  );

  app.post(
    "/api/applications/:id/domains/:domainId/dns/apply",
    {
      preHandler: [requireRole("admin")],
      schema: { params: DomainParams },
      // The provider token passes through this handler.
      logLevel: "silent"
    },
    async (req, reply): Promise<DnsApplyResult | void> => {
      const u = req.user!;
      const { id, domainId } = req.params as z.infer<typeof DomainParams>;

      const existing = await prisma.domain.findFirst({
        where: { id: domainId, application: { id, organizationId: u.organizationId } },
        select: domainSelect
      });
      if (!existing) return reply.notFound();

      // Which provider to use is decided by the domain's own nameservers, not
      // by whatever credentials happen to be stored: writing a record at a
      // provider the zone does not live on would change nothing.
      const dns = await inspectDomain(existing.hostname, config.baseDomain, lookups);
      const providerId = dns.provider?.id;
      if (!providerId || !isApiProvider(providerId)) {
        return reply.badRequest(
          dns.provider
            ? `Sohwe cannot write records at ${dns.provider.name} — add the record there manually.`
            : `Could not tell which DNS provider hosts ${existing.hostname}, so the record cannot be added automatically.`
        );
      }

      const credential = await prisma.dnsProviderCredential.findUnique({
        where: {
          organizationId_provider: {
            organizationId: u.organizationId,
            provider: providerId
          }
        }
      });
      if (!credential) {
        return reply.badRequest(
          `No ${dns.provider?.name ?? providerId} API token is configured for this organization.`
        );
      }

      const expectedIp = await resolveExpectedIp(
        config.baseDomain,
        lookups.resolve4
      );
      if (!expectedIp) {
        return reply.badRequest(
          `Could not determine this instance's public IP: neither ${config.baseDomain} ` +
            "nor a wildcard label under it resolves. Point SOHWE_BASE_DOMAIN at this host first."
        );
      }

      const driver = getDnsDriver(providerId);
      const token = decryptToUtf8(Buffer.from(credential.tokenEncrypted));
      try {
        const zone = await driver.findZone(token, existing.hostname, fetchImpl);
        if (!zone) {
          return reply.badRequest(
            `The configured ${driver.label} token cannot see a zone containing ${existing.hostname}. ` +
              "Check the token's scope, or that the domain is on that provider at all."
          );
        }
        const result = await driver.upsertARecord(
          token,
          zone,
          existing.hostname,
          expectedIp,
          fetchImpl
        );
        await recordAudit(req, {
          action: "dns.record.apply",
          targetType: "dns",
          targetId: existing.id,
          targetLabel: existing.hostname,
          metadata: {
            provider: providerId,
            zone: zone.name,
            action: result.action,
            recordType: "A"
          }
        });
        return {
          action: result.action,
          provider: providerId,
          zone: zone.name,
          record: { type: "A", name: existing.hostname, value: expectedIp },
          ...(result.proxied === undefined ? {} : { proxied: result.proxied })
        };
      } catch (err) {
        // Provider messages are safe to surface; the token never appears in one.
        if (err instanceof DnsApiError) return reply.badRequest(err.message);
        throw err;
      }
    }
  );
}

function isApiProvider(id: string): id is DnsApiProvider {
  return (DNS_API_PROVIDERS as readonly string[]).includes(id);
}

/**
 * The app whose generated `<slug>.<base-domain>` address is `hostname`, or
 * null when the hostname is not one of those.
 */
async function generatedHostOwner(
  hostname: string,
  baseDomain: string,
  organizationId: string
): Promise<{ id: string; name: string } | null> {
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return null;
  const slug = hostname.slice(0, -suffix.length);
  // Only a single label is generated; `a.b.<base>` belongs to nobody.
  if (slug === "" || slug.includes(".")) return null;
  return prisma.application.findFirst({
    where: { organizationId, slug },
    select: { id: true, name: true }
  });
}
