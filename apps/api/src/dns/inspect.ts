// The read-only half of the custom domain feature: where a hostname's DNS zone
// lives, and whether it points at this instance yet.
//
// Shared by `/api/dns/inspect` (ad-hoc checks) and the per-domain verify route,
// so both answer the same question the same way. Every lookup is injected, so
// route tests never touch the network.

import { Resolver } from "node:dns/promises";
import type { DnsInspection, ExpectedIpSource } from "@sohwe/types";
import { cdnForAddress } from "./cdn";
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

/** The instance's own public address, or why it could not be established. */
export type ExpectedIp =
  | { ip: string; source: ExpectedIpSource; issue: null }
  | { ip: null; source: null; issue: string };

/**
 * IPv4 a custom domain must point at.
 *
 * An operator-supplied `SOHWE_PUBLIC_IP` wins outright — it is the only source
 * that cannot be wrong about which machine this is. Otherwise it is discovered
 * from the apps base domain: its own A record first, then a wildcard probe
 * label, since hosts commonly publish only `*.<base-domain>`.
 *
 * A discovered address inside a proxy network is **refused, not returned**. If
 * the base domain sits behind Cloudflare's orange cloud, resolving it yields an
 * edge address; handing that back would make Sohwe advise pointing customer
 * domains at Cloudflare itself, which loops the proxy onto its own edge and
 * serves "Error 1000: DNS points to prohibited IP" — and would then verify
 * clean, because the domain really does resolve to the address Sohwe asked for.
 * Better to have no answer than a confidently wrong one.
 */
export async function resolveExpectedIp(
  baseDomain: string,
  resolve4: (host: string) => Promise<string[]>,
  publicIp?: string | null
): Promise<ExpectedIp> {
  if (publicIp) {
    const cdn = cdnForAddress(publicIp);
    if (cdn) {
      return {
        ip: null,
        source: null,
        issue:
          `SOHWE_PUBLIC_IP is set to ${publicIp}, which belongs to ${cdn}, not to a server. ` +
          "Set it to this host's own public IP address."
      };
    }
    return { ip: publicIp, source: "configured", issue: null };
  }

  for (const host of [baseDomain, `sohwe-dns-probe.${baseDomain}`]) {
    let addr: string | undefined;
    try {
      const addrs = await resolve4(host);
      addr = addrs[0];
    } catch {
      // Try the next candidate.
    }
    if (!addr) continue;

    const cdn = cdnForAddress(addr);
    if (cdn) {
      return {
        ip: null,
        source: null,
        issue:
          `${host} resolves to ${addr}, which is a ${cdn} proxy address rather than this server. ` +
          `Sohwe cannot tell what this host's real IP is, and pointing a domain at ${addr} would ` +
          `make ${cdn} fetch its origin from itself (Error 1000). Either turn off the proxy for ` +
          `the apps base domain, or set SOHWE_PUBLIC_IP to this host's own public IP address.`
      };
    }
    return { ip: addr, source: "base-domain", issue: null };
  }

  return {
    ip: null,
    source: null,
    issue:
      `Neither ${baseDomain} nor a wildcard label under it resolves to an address, so this ` +
      "instance's public IP is unknown. Point SOHWE_BASE_DOMAIN at this host, or set SOHWE_PUBLIC_IP."
  };
}

/**
 * Full inspection of one hostname. Never throws for a DNS-level failure: a
 * domain nobody has configured yet is the normal case, and reports as
 * `unresolved` rather than an error.
 */
export async function inspectDomain(
  domain: string,
  baseDomain: string,
  lookups: DnsLookups,
  publicIp?: string | null
): Promise<DnsInspection> {
  const zoneInfo = await findZoneNameservers(domain, lookups.resolveNs);
  const provider = zoneInfo
    ? matchProvider(zoneInfo.nameservers, zoneInfo.zone)
    : null;

  const expected = await resolveExpectedIp(baseDomain, lookups.resolve4, publicIp);

  let resolvedIps: string[] = [];
  try {
    resolvedIps = await lookups.resolve4(domain);
  } catch {
    // No A records yet — reported as "unresolved" below.
  }

  // A domain sitting behind a proxy is a working setup whose origin simply
  // cannot be seen from out here. It gets its own status rather than being
  // called a mismatch (alarming, and wrong) or verified (wrong, and quiet).
  const proxiedBy = resolvedIps.length > 0 && resolvedIps.every((ip) => cdnForAddress(ip));

  const status: DnsInspection["status"] =
    resolvedIps.length === 0
      ? expected.ip
        ? "unresolved"
        : "unknown"
      : expected.ip && resolvedIps.includes(expected.ip)
        ? "verified"
        : proxiedBy
          ? "proxied"
          : expected.ip
            ? "mismatch"
            : "unknown";

  return {
    domain,
    zone: zoneInfo?.zone ?? null,
    nameservers: zoneInfo?.nameservers ?? [],
    provider,
    expectedIp: expected.ip,
    expectedIpSource: expected.source,
    expectedIpIssue: expected.issue,
    resolvedIps,
    status,
    record: expected.ip ? { type: "A", name: domain, value: expected.ip } : null
  };
}
