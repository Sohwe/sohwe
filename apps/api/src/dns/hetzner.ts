// Hetzner DNS driver. See `driver.ts` for the contract and the two rules every
// driver holds to (the token never leaves the header; an existing CNAME is a
// refusal, not an overwrite).

import {
  DnsApiError,
  pickZoneFor,
  relativeRecordName,
  type DnsDriver,
  type DnsZone,
  type UpsertResult
} from "./driver";

const HETZNER_API = "https://dns.hetzner.com/api/v1";

/** Hetzner's own error messages are safe to surface; the token never is. */
function hetznerError(body: unknown, fallback: string): DnsApiError {
  const err = (body as { error?: { message?: unknown } } | null)?.error;
  const message = err?.message;
  return new DnsApiError(
    typeof message === "string" && message.length > 0
      ? `Hetzner: ${message}`
      : fallback,
    "hetzner"
  );
}

async function hetznerRequest(
  token: string,
  path: string,
  fetchImpl: typeof fetch,
  init: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchImpl(`${HETZNER_API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        // Hetzner DNS uses its own header, not Authorization.
        "auth-api-token": token,
        "content-type": "application/json"
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
  } catch {
    throw new DnsApiError("Could not reach the Hetzner DNS API", "hetzner");
  }
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new DnsApiError(
        `Hetzner DNS API returned an unexpected response (HTTP ${String(res.status)})`,
        "hetzner"
      );
    }
  }
  if (!res.ok) {
    // A wrong token gets a bare 401 with no body worth quoting.
    if (res.status === 401 || res.status === 403) {
      throw new DnsApiError(
        "Hetzner rejected this API token — check that it is a DNS API token and still active.",
        "hetzner"
      );
    }
    throw hetznerError(
      body,
      `Hetzner DNS API request failed (HTTP ${String(res.status)})`
    );
  }
  return body;
}

type HetznerRecord = { id: string; type: string; name: string };

function readRecords(body: unknown): HetznerRecord[] {
  const raw = (body as { records?: unknown } | null)?.records;
  if (!Array.isArray(raw)) return [];
  const out: HetznerRecord[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (typeof r.id === "string" && typeof r.type === "string" && typeof r.name === "string") {
      out.push({ id: r.id, type: r.type, name: r.name });
    }
  }
  return out;
}

export const hetznerDriver: DnsDriver = {
  id: "hetzner",
  label: "Hetzner",
  tokenHelp: {
    url: "https://dns.hetzner.com/settings/api-token",
    scope: "a DNS API token (Hetzner DNS Console → API tokens)"
  },

  async verifyToken(token, fetchImpl) {
    // Listing zones is the cheapest authenticated call; a bad token 401s.
    await hetznerRequest(token, "/zones?per_page=1", fetchImpl);
  },

  async findZone(token, domain, fetchImpl) {
    const zones: DnsZone[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await hetznerRequest(
        token,
        `/zones?per_page=100&page=${String(page)}`,
        fetchImpl
      );
      const raw = (body as { zones?: unknown } | null)?.zones;
      const list = Array.isArray(raw) ? raw : [];
      for (const z of list as { id?: unknown; name?: unknown }[]) {
        if (typeof z.id === "string" && typeof z.name === "string") {
          zones.push({ id: z.id, name: z.name.toLowerCase() });
        }
      }
      if (list.length < 100) break;
    }
    return pickZoneFor(domain, zones);
  },

  async upsertARecord(token, zone, name, ip, fetchImpl): Promise<UpsertResult> {
    const label = relativeRecordName(name, zone.name);
    // Hetzner has no server-side name filter on /records, so the zone's records
    // come back whole and the match happens here.
    const body = await hetznerRequest(
      token,
      `/records?zone_id=${encodeURIComponent(zone.id)}&per_page=1000`,
      fetchImpl
    );
    const forName = readRecords(body).filter((r) => r.name === label);

    if (forName.some((r) => r.type === "CNAME")) {
      throw new DnsApiError(
        `A CNAME record already exists for ${name} — remove it in Hetzner DNS first, or keep managing this domain manually.`,
        "hetzner"
      );
    }

    const existing = forName.find((r) => r.type === "A");
    const payload = {
      zone_id: zone.id,
      type: "A",
      name: label,
      value: ip,
      ttl: 300
    };

    if (existing) {
      await hetznerRequest(token, `/records/${encodeURIComponent(existing.id)}`, fetchImpl, {
        method: "PUT",
        body: payload
      });
      return { action: "updated" };
    }

    await hetznerRequest(token, "/records", fetchImpl, {
      method: "POST",
      body: payload
    });
    return { action: "created" };
  }
};
