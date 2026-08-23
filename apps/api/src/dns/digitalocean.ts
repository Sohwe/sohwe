// DigitalOcean DNS driver. See `driver.ts` for the contract and the two rules
// every driver holds to (the token never leaves the header; an existing CNAME
// is a refusal, not an overwrite).

import {
  DnsApiError,
  pickZoneFor,
  relativeRecordName,
  type DnsDriver,
  type DnsZone,
  type UpsertResult
} from "./driver";

const DO_API = "https://api.digitalocean.com/v2";

/** DigitalOcean's own error messages are safe to surface; the token never is. */
function doError(body: unknown, fallback: string): DnsApiError {
  const message = (body as { message?: unknown } | null)?.message;
  return new DnsApiError(
    typeof message === "string" && message.length > 0
      ? `DigitalOcean: ${message}`
      : fallback,
    "digitalocean"
  );
}

async function doRequest(
  token: string,
  path: string,
  fetchImpl: typeof fetch,
  init: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchImpl(`${DO_API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
  } catch {
    throw new DnsApiError(
      "Could not reach the DigitalOcean API",
      "digitalocean"
    );
  }
  // 204 on delete, and any empty body, parse as null rather than throwing.
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new DnsApiError(
        `DigitalOcean API returned an unexpected response (HTTP ${String(res.status)})`,
        "digitalocean"
      );
    }
  }
  if (!res.ok) {
    throw doError(
      body,
      `DigitalOcean API request failed (HTTP ${String(res.status)})`
    );
  }
  return body;
}

type DoRecord = { id: number; type: string; name: string };

function readRecords(body: unknown): DoRecord[] {
  const raw = (body as { domain_records?: unknown } | null)?.domain_records;
  if (!Array.isArray(raw)) return [];
  const out: DoRecord[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (typeof r.id === "number" && typeof r.type === "string" && typeof r.name === "string") {
      out.push({ id: r.id, type: r.type, name: r.name });
    }
  }
  return out;
}

export const digitalOceanDriver: DnsDriver = {
  id: "digitalocean",
  label: "DigitalOcean",
  tokenHelp: {
    url: "https://cloud.digitalocean.com/account/api/tokens",
    scope: "a personal access token with write scope"
  },

  async verifyToken(token, fetchImpl) {
    // Cheapest authenticated call there is; a bad token 401s here.
    await doRequest(token, "/account", fetchImpl);
  },

  async findZone(token, domain, fetchImpl) {
    const zones: DnsZone[] = [];
    // DigitalOcean paginates, but 200 domains per page covers any realistic
    // account in one or two requests; the loop is bounded either way.
    for (let page = 1; page <= 10; page++) {
      const body = await doRequest(
        token,
        `/domains?per_page=200&page=${String(page)}`,
        fetchImpl
      );
      const raw = (body as { domains?: unknown } | null)?.domains;
      const list = Array.isArray(raw) ? raw : [];
      for (const d of list as { name?: unknown }[]) {
        if (typeof d.name === "string") {
          const name = d.name.toLowerCase();
          // The zone name *is* the identifier in DigitalOcean's record URLs.
          zones.push({ id: name, name });
        }
      }
      if (list.length < 200) break;
    }
    return pickZoneFor(domain, zones);
  },

  async upsertARecord(token, zone, name, ip, fetchImpl): Promise<UpsertResult> {
    const label = relativeRecordName(name, zone.name);
    const body = await doRequest(
      token,
      `/domains/${encodeURIComponent(zone.id)}/records?name=${encodeURIComponent(name)}&per_page=200`,
      fetchImpl
    );
    const records = readRecords(body);

    if (records.some((r) => r.type === "CNAME")) {
      throw new DnsApiError(
        `A CNAME record already exists for ${name} — remove it in DigitalOcean first, or keep managing this domain manually.`,
        "digitalocean"
      );
    }

    const existing = records.find((r) => r.type === "A");
    if (existing) {
      await doRequest(
        token,
        `/domains/${encodeURIComponent(zone.id)}/records/${String(existing.id)}`,
        fetchImpl,
        { method: "PUT", body: { type: "A", name: label, data: ip, ttl: 1800 } }
      );
      return { action: "updated" };
    }

    await doRequest(
      token,
      `/domains/${encodeURIComponent(zone.id)}/records`,
      fetchImpl,
      { method: "POST", body: { type: "A", name: label, data: ip, ttl: 1800 } }
    );
    return { action: "created" };
  }
};
