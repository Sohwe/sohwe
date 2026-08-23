import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspectDomain, resolveExpectedIp, type DnsLookups } from "./inspect";

const BASE = "apps.example.com";
const ORIGIN = "203.0.113.10";
/** A real Cloudflare edge address — the one that served an Error 1000. */
const CF_EDGE = "172.67.148.151";

const answers =
  (map: Record<string, string[]>) =>
  async (host: string): Promise<string[]> => {
    const a = map[host];
    if (!a) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return a;
  };

/** Cloudflare-hosted zone, so the provider block of an inspection is populated. */
const cloudflareNs = async (host: string): Promise<string[]> => {
  if (host === "example.com") return ["dee.ns.cloudflare.com", "gail.ns.cloudflare.com"];
  throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
};

const lookups = (map: Record<string, string[]>): DnsLookups => ({
  resolveNs: cloudflareNs,
  resolve4: answers(map)
});

describe("resolveExpectedIp", () => {
  it("uses the base domain's address when it is a real origin", async () => {
    const out = await resolveExpectedIp(BASE, answers({ [BASE]: [ORIGIN] }));
    assert.deepEqual(out, { ip: ORIGIN, source: "base-domain", issue: null });
  });

  it("falls back to the wildcard probe label", async () => {
    // Hosts commonly publish only `*.<base-domain>`, not the apex.
    const out = await resolveExpectedIp(
      BASE,
      answers({ [`sohwe-dns-probe.${BASE}`]: [ORIGIN] })
    );
    assert.equal(out.ip, ORIGIN);
    assert.equal(out.source, "base-domain");
  });

  it("refuses a proxy address instead of passing it off as the origin", async () => {
    // The regression this guards: a proxied base domain resolves to a
    // Cloudflare edge, and returning it would have Sohwe tell people to point
    // their domains at Cloudflare — which loops it onto itself (Error 1000).
    const out = await resolveExpectedIp(BASE, answers({ [BASE]: [CF_EDGE] }));
    assert.equal(out.ip, null);
    assert.match(out.issue ?? "", /Cloudflare proxy address/);
    assert.match(out.issue ?? "", /SOHWE_PUBLIC_IP/);
    assert.match(out.issue ?? "", /Error 1000/);
  });

  it("does not fall through to the probe label after refusing the apex", async () => {
    // Both are proxied in the real failing setup; the answer stays "unknown"
    // rather than quietly taking the second edge address.
    const out = await resolveExpectedIp(
      BASE,
      answers({ [BASE]: [CF_EDGE], [`sohwe-dns-probe.${BASE}`]: ["104.16.0.1"] })
    );
    assert.equal(out.ip, null);
  });

  it("prefers an operator-supplied address over any lookup", async () => {
    const out = await resolveExpectedIp(BASE, answers({ [BASE]: [CF_EDGE] }), ORIGIN);
    assert.deepEqual(out, { ip: ORIGIN, source: "configured", issue: null });
  });

  it("rejects an operator-supplied address that is itself a proxy", async () => {
    const out = await resolveExpectedIp(BASE, answers({}), CF_EDGE);
    assert.equal(out.ip, null);
    assert.match(out.issue ?? "", /SOHWE_PUBLIC_IP is set to/);
  });

  it("explains an unresolvable base domain", async () => {
    const out = await resolveExpectedIp(BASE, answers({}));
    assert.equal(out.ip, null);
    assert.match(out.issue ?? "", /Point SOHWE_BASE_DOMAIN at this host/);
  });
});

describe("inspectDomain", () => {
  it("verifies a domain pointing straight at the origin", async () => {
    const d = await inspectDomain(
      "app.example.com",
      BASE,
      lookups({ [BASE]: [ORIGIN], "app.example.com": [ORIGIN] })
    );
    assert.equal(d.status, "verified");
    assert.equal(d.expectedIpSource, "base-domain");
    assert.equal(d.expectedIpIssue, null);
    assert.deepEqual(d.record, { type: "A", name: "app.example.com", value: ORIGIN });
  });

  it("reports a proxied domain as proxied, not verified or mismatched", async () => {
    const d = await inspectDomain(
      "app.example.com",
      BASE,
      lookups({ [BASE]: [ORIGIN], "app.example.com": [CF_EDGE] })
    );
    assert.equal(d.status, "proxied");
  });

  it("still reports a genuine mismatch", async () => {
    const d = await inspectDomain(
      "app.example.com",
      BASE,
      lookups({ [BASE]: [ORIGIN], "app.example.com": ["198.51.100.7"] })
    );
    assert.equal(d.status, "mismatch");
  });

  it("suggests no record, and never verifies, when the base domain is proxied", async () => {
    // The exact broken setup: base domain behind the orange cloud, and the
    // domain already pointing at an edge address. Before the guard this
    // reported `verified` over a site serving Error 1000.
    const d = await inspectDomain(
      "app.example.com",
      BASE,
      lookups({ [BASE]: [CF_EDGE], "app.example.com": [CF_EDGE] })
    );
    assert.notEqual(d.status, "verified");
    assert.equal(d.status, "proxied");
    assert.equal(d.expectedIp, null);
    assert.equal(d.record, null, "must not suggest a record it cannot compute");
    assert.match(d.expectedIpIssue ?? "", /proxy address/);
  });

  it("uses SOHWE_PUBLIC_IP to verify through a proxied base domain", async () => {
    // With the origin stated outright, a directly-pointed domain verifies even
    // though resolving the base domain would only find an edge.
    const d = await inspectDomain(
      "app.example.com",
      BASE,
      lookups({ [BASE]: [CF_EDGE], "app.example.com": [ORIGIN] }),
      ORIGIN
    );
    assert.equal(d.status, "verified");
    assert.equal(d.expectedIpSource, "configured");
  });

  it("reports unresolved only when the origin is known", async () => {
    const known = await inspectDomain("app.example.com", BASE, lookups({ [BASE]: [ORIGIN] }));
    assert.equal(known.status, "unresolved");

    const unknown = await inspectDomain("app.example.com", BASE, lookups({}));
    assert.equal(unknown.status, "unknown");
  });
});
