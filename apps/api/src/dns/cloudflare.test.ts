import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CloudflareApiError,
  findCloudflareZone,
  upsertCloudflareARecord,
  verifyCloudflareToken
} from "./cloudflare";

const TOKEN = "cf-test-token-abc123xyz";

type Call = { url: string; method: string; body: unknown };

/**
 * Fake `fetch` for the Cloudflare API. Routes are matched by "METHOD path"
 * prefix against the URL's path+query; every call is recorded for assertions.
 */
function fakeCf(
  routes: Record<string, { status?: number; body: unknown }>
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    });
    const path = url.replace("https://api.cloudflare.com/client/v4", "");
    for (const [route, res] of Object.entries(routes)) {
      const [rMethod, rPath] = route.split(" ", 2);
      if (method === rMethod && rPath && path.startsWith(rPath)) {
        return new Response(JSON.stringify(res.body), {
          status: res.status ?? 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
    return new Response(
      JSON.stringify({ success: false, errors: [{ message: `no fake for ${method} ${path}` }] }),
      { status: 404, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (result: unknown, extra: Record<string, unknown> = {}) => ({
  body: { success: true, errors: [], result, ...extra }
});

describe("verifyCloudflareToken", () => {
  it("accepts an active token and sends it only as a bearer header", async () => {
    const { fetchImpl, calls } = fakeCf({
      "GET /user/tokens/verify": ok({ status: "active" })
    });
    await verifyCloudflareToken(TOKEN, fetchImpl);
    assert.equal(calls.length, 1);
    assert.ok(!calls[0]!.url.includes(TOKEN), "token must not appear in the URL");
  });

  it("rejects an inactive token", async () => {
    const { fetchImpl } = fakeCf({
      "GET /user/tokens/verify": ok({ status: "disabled" })
    });
    await assert.rejects(
      verifyCloudflareToken(TOKEN, fetchImpl),
      (err: unknown) =>
        err instanceof CloudflareApiError && err.message.includes("not active")
    );
  });

  it("surfaces Cloudflare's error message, never the token", async () => {
    const { fetchImpl } = fakeCf({
      "GET /user/tokens/verify": {
        status: 401,
        body: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }
      }
    });
    await assert.rejects(
      verifyCloudflareToken(TOKEN, fetchImpl),
      (err: unknown) =>
        err instanceof CloudflareApiError &&
        err.message.includes("Invalid API Token") &&
        !err.message.includes(TOKEN)
    );
  });
});

describe("findCloudflareZone", () => {
  it("picks the longest zone that is a dot-boundary suffix of the domain", async () => {
    const { fetchImpl } = fakeCf({
      "GET /zones": ok(
        [
          { id: "z1", name: "ple.com" },
          { id: "z2", name: "example.com" },
          { id: "z3", name: "unrelated.net" }
        ],
        { result_info: { page: 1, total_pages: 1 } }
      )
    });
    const zone = await findCloudflareZone(TOKEN, "app.example.com", fetchImpl);
    // "app.example.com" ends with the substring "ple.com" but not ".ple.com" —
    // substring matching would cross a label boundary and pick the wrong zone.
    assert.deepEqual(zone, { id: "z2", name: "example.com" });
  });

  it("matches a domain that is the zone apex itself", async () => {
    const { fetchImpl } = fakeCf({
      "GET /zones": ok([{ id: "z1", name: "example.com" }], {
        result_info: { page: 1, total_pages: 1 }
      })
    });
    const zone = await findCloudflareZone(TOKEN, "example.com", fetchImpl);
    assert.equal(zone?.id, "z1");
  });

  it("returns null when no zone contains the domain", async () => {
    const { fetchImpl } = fakeCf({
      "GET /zones": ok([{ id: "z1", name: "other.com" }], {
        result_info: { page: 1, total_pages: 1 }
      })
    });
    assert.equal(await findCloudflareZone(TOKEN, "app.example.com", fetchImpl), null);
  });

  it("walks paginated zone lists", async () => {
    let served = 0;
    const fetchImpl = (async () => {
      served++;
      const page = served;
      const result =
        page === 1 ? [{ id: "z1", name: "first.com" }] : [{ id: "z2", name: "example.com" }];
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result,
          result_info: { page, total_pages: 2 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    const zone = await findCloudflareZone(TOKEN, "app.example.com", fetchImpl);
    assert.equal(zone?.id, "z2");
    assert.equal(served, 2);
  });
});

describe("upsertCloudflareARecord", () => {
  const ZONE = { id: "z1", name: "example.com" };

  it("creates a DNS-only record when none exists", async () => {
    const { fetchImpl, calls } = fakeCf({
      "GET /zones/z1/dns_records": ok([]),
      "POST /zones/z1/dns_records": ok({ id: "r1" })
    });
    const res = await upsertCloudflareARecord(
      TOKEN,
      ZONE,
      "app.example.com",
      "203.0.113.10",
      fetchImpl
    );
    assert.deepEqual(res, { action: "created", proxied: false });
    const create = calls.find((c) => c.method === "POST");
    assert.deepEqual(create?.body, {
      type: "A",
      name: "app.example.com",
      content: "203.0.113.10",
      ttl: 1,
      proxied: false
    });
  });

  it("updates an existing A record and keeps its proxied setting", async () => {
    const { fetchImpl, calls } = fakeCf({
      "GET /zones/z1/dns_records?": ok([
        { id: "r9", type: "A", name: "app.example.com", proxied: true, content: "198.51.100.1" }
      ]),
      "PUT /zones/z1/dns_records/r9": ok({ id: "r9" })
    });
    const res = await upsertCloudflareARecord(
      TOKEN,
      ZONE,
      "app.example.com",
      "203.0.113.10",
      fetchImpl
    );
    assert.deepEqual(res, { action: "updated", proxied: true });
    const update = calls.find((c) => c.method === "PUT");
    assert.equal((update?.body as { proxied: boolean }).proxied, true);
    assert.equal((update?.body as { content: string }).content, "203.0.113.10");
  });

  it("refuses to touch a name that already has a CNAME", async () => {
    const { fetchImpl, calls } = fakeCf({
      "GET /zones/z1/dns_records": ok([
        { id: "r2", type: "CNAME", name: "app.example.com", proxied: false }
      ])
    });
    await assert.rejects(
      upsertCloudflareARecord(TOKEN, ZONE, "app.example.com", "203.0.113.10", fetchImpl),
      (err: unknown) =>
        err instanceof CloudflareApiError &&
        err.message.includes("CNAME") &&
        !err.message.includes(TOKEN)
    );
    // Refusal means refusal: nothing was written.
    assert.ok(calls.every((c) => c.method === "GET"));
  });
});
