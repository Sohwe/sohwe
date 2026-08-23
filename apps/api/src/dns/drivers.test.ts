import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DnsApiError, pickZoneFor, relativeRecordName } from "./driver";
import { digitalOceanDriver } from "./digitalocean";
import { hetznerDriver } from "./hetzner";
import { getDnsDriver, listDnsDrivers } from "./drivers";

const TOKEN = "dns-test-token-abc123xyz";

type Call = {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
};

/**
 * Fake `fetch` for a provider API. Routes are matched by "METHOD path" prefix
 * against the URL's path+query; every call is recorded so the tests can assert
 * both the request that went out and that the token stayed in the header.
 */
function fakeApi(
  origin: string,
  routes: Record<string, { status?: number; body: unknown }>
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>
    });
    const path = url.replace(origin, "");
    for (const [route, res] of Object.entries(routes)) {
      const [rMethod, rPath] = route.split(" ", 2);
      if (method === rMethod && rPath && path.startsWith(rPath)) {
        return new Response(JSON.stringify(res.body), {
          status: res.status ?? 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
    return new Response(JSON.stringify({ message: `no fake for ${method} ${path}` }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const DO = "https://api.digitalocean.com/v2";
const HZ = "https://dns.hetzner.com/api/v1";

describe("relativeRecordName", () => {
  it("uses @ for the zone apex", () => {
    assert.equal(relativeRecordName("example.com", "example.com"), "@");
  });

  it("strips the zone suffix from a subdomain", () => {
    assert.equal(relativeRecordName("app.example.com", "example.com"), "app");
    assert.equal(relativeRecordName("a.b.example.com", "example.com"), "a.b");
  });

  it("leaves a name outside the zone alone", () => {
    assert.equal(relativeRecordName("app.other.com", "example.com"), "app.other.com");
  });
});

describe("pickZoneFor", () => {
  it("prefers the longest matching zone", () => {
    const zones = [{ name: "example.com" }, { name: "sub.example.com" }];
    assert.equal(pickZoneFor("app.sub.example.com", zones)?.name, "sub.example.com");
  });

  it("matches only on a dot boundary", () => {
    // The regression this guards: `foo-example.com` is not inside
    // `example.com`, and writing the record there would change nothing.
    const zones = [{ name: "example.com" }];
    assert.equal(pickZoneFor("app.foo-example.com", zones), null);
  });

  it("matches the apex itself", () => {
    assert.equal(pickZoneFor("example.com", [{ name: "example.com" }])?.name, "example.com");
  });
});

describe("driver registry", () => {
  it("resolves every advertised provider to a driver whose id matches", () => {
    for (const driver of listDnsDrivers()) {
      assert.equal(getDnsDriver(driver.id).id, driver.id);
      assert.ok(driver.tokenHelp.url.startsWith("https://"), driver.id);
    }
  });
});

describe("digitalOceanDriver", () => {
  it("creates an A record with the label relative to the zone", async () => {
    const { fetchImpl, calls } = fakeApi(DO, {
      "GET /domains/example.com/records": { body: { domain_records: [] } },
      "GET /domains": { body: { domains: [{ name: "example.com" }] } },
      "POST /domains/example.com/records": { body: { domain_record: { id: 1 } } }
    });
    const zone = await digitalOceanDriver.findZone(TOKEN, "app.example.com", fetchImpl);
    assert.deepEqual(zone, { id: "example.com", name: "example.com" });

    const result = await digitalOceanDriver.upsertARecord(
      TOKEN,
      zone!,
      "app.example.com",
      "203.0.113.10",
      fetchImpl
    );
    assert.deepEqual(result, { action: "created" });

    const post = calls.find((c) => c.method === "POST");
    assert.deepEqual(post?.body, {
      type: "A",
      name: "app",
      data: "203.0.113.10",
      ttl: 1800
    });
    // The token belongs in the header and nowhere else.
    assert.equal(calls[0]?.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(!JSON.stringify(calls.map((c) => [c.url, c.body])).includes(TOKEN));
  });

  it("updates an existing A record in place", async () => {
    const { fetchImpl, calls } = fakeApi(DO, {
      "GET /domains/example.com/records": {
        body: { domain_records: [{ id: 42, type: "A", name: "app" }] }
      },
      "PUT /domains/example.com/records/42": { body: { domain_record: { id: 42 } } }
    });
    const result = await digitalOceanDriver.upsertARecord(
      TOKEN,
      { id: "example.com", name: "example.com" },
      "app.example.com",
      "203.0.113.10",
      fetchImpl
    );
    assert.deepEqual(result, { action: "updated" });
    assert.ok(calls.some((c) => c.method === "PUT" && c.url.endsWith("/42")));
  });

  it("refuses to overwrite an existing CNAME", async () => {
    const { fetchImpl, calls } = fakeApi(DO, {
      "GET /domains/example.com/records": {
        body: { domain_records: [{ id: 7, type: "CNAME", name: "app" }] }
      }
    });
    await assert.rejects(
      () =>
        digitalOceanDriver.upsertARecord(
          TOKEN,
          { id: "example.com", name: "example.com" },
          "app.example.com",
          "203.0.113.10",
          fetchImpl
        ),
      /CNAME record already exists/
    );
    // Nothing was written.
    assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
  });

  it("surfaces the provider's own error message, never the token", async () => {
    const { fetchImpl } = fakeApi(DO, {
      "GET /account": { status: 401, body: { message: "Unable to authenticate you" } }
    });
    await assert.rejects(
      () => digitalOceanDriver.verifyToken(TOKEN, fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof DnsApiError);
        assert.equal(err.provider, "digitalocean");
        assert.match(err.message, /Unable to authenticate you/);
        assert.ok(!err.message.includes(TOKEN));
        return true;
      }
    );
  });
});

describe("hetznerDriver", () => {
  it("creates an A record scoped to the zone id", async () => {
    const { fetchImpl, calls } = fakeApi(HZ, {
      "GET /zones": { body: { zones: [{ id: "z1", name: "example.com" }] } },
      "GET /records": { body: { records: [] } },
      "POST /records": { body: { record: { id: "r1" } } }
    });
    const zone = await hetznerDriver.findZone(TOKEN, "app.example.com", fetchImpl);
    assert.deepEqual(zone, { id: "z1", name: "example.com" });

    const result = await hetznerDriver.upsertARecord(
      TOKEN,
      zone!,
      "app.example.com",
      "203.0.113.10",
      fetchImpl
    );
    assert.deepEqual(result, { action: "created" });

    const post = calls.find((c) => c.method === "POST");
    assert.deepEqual(post?.body, {
      zone_id: "z1",
      type: "A",
      name: "app",
      value: "203.0.113.10",
      ttl: 300
    });
    assert.equal(calls[0]?.headers["auth-api-token"], TOKEN);
    assert.ok(!JSON.stringify(calls.map((c) => [c.url, c.body])).includes(TOKEN));
  });

  it("matches records by their in-zone label, not the fqdn", async () => {
    // Hetzner has no server-side name filter, so the whole zone comes back and
    // the match happens locally — an unrelated `app2` must not be updated.
    const { fetchImpl, calls } = fakeApi(HZ, {
      "GET /records": {
        body: {
          records: [
            { id: "other", type: "A", name: "app2" },
            { id: "mine", type: "A", name: "app" }
          ]
        }
      },
      "PUT /records/mine": { body: { record: { id: "mine" } } }
    });
    const result = await hetznerDriver.upsertARecord(
      TOKEN,
      { id: "z1", name: "example.com" },
      "app.example.com",
      "203.0.113.10",
      fetchImpl
    );
    assert.deepEqual(result, { action: "updated" });
    assert.ok(calls.some((c) => c.method === "PUT" && c.url.endsWith("/records/mine")));
  });

  it("explains a rejected token without echoing it", async () => {
    const { fetchImpl } = fakeApi(HZ, {
      "GET /zones": { status: 401, body: {} }
    });
    await assert.rejects(
      () => hetznerDriver.verifyToken(TOKEN, fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof DnsApiError);
        assert.equal(err.provider, "hetzner");
        assert.match(err.message, /rejected this API token/);
        assert.ok(!err.message.includes(TOKEN));
        return true;
      }
    );
  });
});
