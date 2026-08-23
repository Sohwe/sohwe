// The read-only half of the custom domain feature: where a hostname's DNS zone
// lives, and whether it points at this instance yet.
//
// Shared by `/api/dns/inspect` (ad-hoc checks) and the per-domain verify route,
// so both answer the same question the same way. Every lookup is injected, so
// route tests never touch the network.

import { Resolver } from "node:dns/promises";
import type { DnsInspection } from "@sohwe/types";
import { findZoneNameservers, matchProvider, type NsLookup } from "./providers";

export type DnsLookups = {
  resolveNs: NsLookup;
  resolve4: (host: string) => Promise<string[]>;
};

/** DNS/HTTP doubles a test can inject in place of the real network. */
export type DnsRouteDeps = Partial<DnsLookups> & { fetchImpl?: typeof fetch };

/**
 * Real resolvers, with any of them overridable by a test double. One resolver
 * per server instance, with a short timeout so a dead upstream turns into a
 * degraded inspection rather than a hung request.
 */
export function createDnsLookups(overrides: Partial<DnsLookups> = {}): DnsLookups {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  return {
    resolveNs: overrides.resolveNs ?? ((host) => resolver.resolveNs(host)),
    resolve4: overrides.resolve4 ?? ((host) => resolver.resolve4(host))
  };
}

/**
 * IPv4 a custom domain must point at, discovered from the apps base domain:
 * its own A record first, then a wildcard probe label — hosts commonly publish
 * only `*.<base-domain>`. Null when neither resolves (e.g. local dev).
 */
export async function resolveExpectedIp(
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

/**
 * Full inspection of one hostname. Never throws for a DNS-level failure: a
 * domain nobody has configured yet is the normal case, and reports as
 * `unresolved` rather than an error.
 */
export async function inspectDomain(
  domain: string,
  baseDomain: string,
  lookups: DnsLookups
): Promise<DnsInspection> {
  const zoneInfo = await findZoneNameservers(domain, lookups.resolveNs);
  const provider = zoneInfo
    ? matchProvider(zoneInfo.nameservers, zoneInfo.zone)
    : null;

  const expectedIp = await resolveExpectedIp(baseDomain, lookups.resolve4);

  let resolvedIps: string[] = [];
  try {
    resolvedIps = await lookups.resolve4(domain);
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
    record: expectedIp ? { type: "A", name: domain, value: expectedIp } : null
  };
}
