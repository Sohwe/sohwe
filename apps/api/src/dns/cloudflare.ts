// Minimal Cloudflare API client for the DNS assist (Phase 8). Talks only to
// the endpoints the feature needs: token verification, zone discovery, and
// A-record upsert. `fetch` is injected so tests run against a fake.
//
// The token is a secret. It goes into the Authorization header and nowhere
// else — never into thrown errors, which surface in API responses and logs.

const CF_API = "https://api.cloudflare.com/client/v4";

export class CloudflareApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export type CloudflareZone = { id: string; name: string };

type CfEnvelope = {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: unknown;
  result_info?: { page?: number; total_pages?: number };
};

/** Cloudflare's own error messages are safe to surface; the token never is. */
function envelopeError(body: CfEnvelope, fallback: string): CloudflareApiError {
  const detail = (body.errors ?? [])
    .map((e) => e.message)
    .filter((m): m is string => typeof m === "string" && m.length > 0)
    .join("; ");
  return new CloudflareApiError(detail.length > 0 ? `Cloudflare: ${detail}` : fallback);
}

async function cfRequest(
  token: string,
  path: string,
  fetchImpl: typeof fetch,
  init: { method?: string; body?: unknown } = {}
): Promise<CfEnvelope> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchImpl(`${CF_API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
  } catch {
    throw new CloudflareApiError("Could not reach the Cloudflare API");
  }
  let body: CfEnvelope;
  try {
    body = (await res.json()) as CfEnvelope;
  } catch {
    throw new CloudflareApiError(
      `Cloudflare API returned an unexpected response (HTTP ${String(res.status)})`
    );
  }
  if (!res.ok || body.success !== true) {
    throw envelopeError(
      body,
      `Cloudflare API request failed (HTTP ${String(res.status)})`
    );
  }
  return body;
}

/** Throws unless the token is valid and active. */
export async function verifyCloudflareToken(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const body = await cfRequest(token, "/user/tokens/verify", fetchImpl);
  const status = (body.result as { status?: string } | undefined)?.status;
  if (status !== "active") {
    throw new CloudflareApiError(
      `Cloudflare token is not active (status: ${status ?? "unknown"})`
    );
  }
}

/**
 * Find the zone containing `domain` among the zones the token can see. A
 * scoped token typically sees exactly one zone, but matching is still by the
 * longest name that is `domain` itself or a dot-boundary suffix of it, so a
 * token spanning `example.com` and `foo-example.com` cannot mismatch.
 */
export async function findCloudflareZone(
  token: string,
  domain: string,
  fetchImpl: typeof fetch = fetch
): Promise<CloudflareZone | null> {
  const zones: CloudflareZone[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = await cfRequest(
      token,
      `/zones?per_page=50&page=${String(page)}`,
      fetchImpl
    );
    const result = Array.isArray(body.result) ? body.result : [];
    for (const z of result as { id?: unknown; name?: unknown }[]) {
      if (typeof z.id === "string" && typeof z.name === "string") {
        zones.push({ id: z.id, name: z.name.toLowerCase() });
      }
    }
    const totalPages = body.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
  }
  let best: CloudflareZone | null = null;
  for (const zone of zones) {
    const matches = domain === zone.name || domain.endsWith(`.${zone.name}`);
    if (matches && (!best || zone.name.length > best.name.length)) {
      best = zone;
    }
  }
  return best;
}

type CfRecord = {
  id: string;
  type: string;
  name: string;
  proxied: boolean;
};

/**
 * Create or update the A record for `name` in `zone`, pointing at `ip`.
 * Created records are DNS-only (`proxied: false`) so verification and ACME
 * work out of the box; an update keeps the record's existing proxied setting —
 * turning off someone's deliberate orange cloud is not this feature's call.
 * An existing CNAME on the same name is a refusal, not an overwrite.
 */
export async function upsertCloudflareARecord(
  token: string,
  zone: CloudflareZone,
  name: string,
  ip: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ action: "created" | "updated"; proxied: boolean }> {
  const listBody = await cfRequest(
    token,
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
    fetchImpl
  );
  const records: CfRecord[] = [];
  const rawList = Array.isArray(listBody.result) ? listBody.result : [];
  for (const r of rawList as Partial<Record<keyof CfRecord, unknown>>[]) {
    if (typeof r.id === "string" && typeof r.type === "string" && typeof r.name === "string") {
      records.push({
        id: r.id,
        type: r.type,
        name: r.name,
        proxied: r.proxied === true
      });
    }
  }

  const cname = records.find((r) => r.type === "CNAME");
  if (cname) {
    throw new CloudflareApiError(
      `A CNAME record already exists for ${name} — remove it in Cloudflare first, or keep managing this domain manually.`
    );
  }

  const existing = records.find((r) => r.type === "A");
  if (existing) {
    await cfRequest(
      token,
      `/zones/${zone.id}/dns_records/${existing.id}`,
      fetchImpl,
      {
        method: "PUT",
        body: {
          type: "A",
          name,
          content: ip,
          ttl: 1,
          proxied: existing.proxied
        }
      }
    );
    return { action: "updated", proxied: existing.proxied };
  }

  await cfRequest(token, `/zones/${zone.id}/dns_records`, fetchImpl, {
    method: "POST",
    body: { type: "A", name, content: ip, ttl: 1, proxied: false }
  });
  return { action: "created", proxied: false };
}
