/**
 * The shape every DNS provider integration implements, so the routes can say
 * "apply this record" without knowing whose API is behind it.
 *
 * Detection (which provider hosts a zone, from its nameservers) covers many
 * more providers than this — see `providers.ts`. A driver exists only where
 * Sohwe can also *write* the record, which needs an API with a single bearer
 * token an operator can paste in.
 *
 * Two rules hold across every implementation:
 *
 * 1. The token is a secret. It goes in a request header and nowhere else —
 *    never into a thrown message, which surfaces in API responses and logs.
 * 2. An existing CNAME on the target name is a refusal, not an overwrite.
 *    Replacing someone's CNAME silently breaks whatever it pointed at.
 */

import type { DnsApiProvider } from "@sohwe/types";

/** A provider-side failure with a message that is safe to show the user. */
export class DnsApiError extends Error {
  constructor(
    message: string,
    readonly provider: DnsApiProvider
  ) {
    super(message);
    this.name = "DnsApiError";
  }
}

/** A zone as the provider identifies it. `id` may equal `name` (DigitalOcean). */
export type DnsZone = { id: string; name: string };

export type UpsertResult = {
  action: "created" | "updated";
  /** Only Cloudflare has a proxy in front of records; undefined elsewhere. */
  proxied?: boolean;
};

export type DnsDriver = {
  id: DnsApiProvider;
  /** Human name, matching the detection registry's label. */
  label: string;
  /** Where the operator creates a token, and what scope it needs. */
  tokenHelp: { url: string; scope: string };
  /** Throws `DnsApiError` unless the token works. */
  verifyToken(token: string, fetchImpl: typeof fetch): Promise<void>;
  /** The zone containing `domain` among those the token can see, or null. */
  findZone(
    token: string,
    domain: string,
    fetchImpl: typeof fetch
  ): Promise<DnsZone | null>;
  /** Point `name` at `ip`, creating or updating the A record. */
  upsertARecord(
    token: string,
    zone: DnsZone,
    name: string,
    ip: string,
    fetchImpl: typeof fetch
  ): Promise<UpsertResult>;
};

/**
 * The label a record has *inside* its zone: `@` for the zone apex, otherwise
 * the part of the fqdn above it. DigitalOcean and Hetzner both address records
 * this way; Cloudflare takes the full name and needs none of this.
 */
export function relativeRecordName(fqdn: string, zoneName: string): string {
  if (fqdn === zoneName) return "@";
  const suffix = `.${zoneName}`;
  return fqdn.endsWith(suffix) ? fqdn.slice(0, -suffix.length) : fqdn;
}

/**
 * Longest zone that is `domain` itself or a dot-boundary suffix of it. Matching
 * on the dot boundary matters: a token that can see both `example.com` and
 * `foo-example.com` must not pick the wrong one for `app.foo-example.com`.
 */
export function pickZoneFor<T extends { name: string }>(
  domain: string,
  zones: T[]
): T | null {
  let best: T | null = null;
  for (const zone of zones) {
    const matches = domain === zone.name || domain.endsWith(`.${zone.name}`);
    if (matches && (!best || zone.name.length > best.name.length)) best = zone;
  }
  return best;
}
