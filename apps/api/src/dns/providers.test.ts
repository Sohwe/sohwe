import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findZoneNameservers,
  matchProvider,
  normalizeNsHost
} from "./providers";

describe("normalizeNsHost", () => {
  it("lowercases and strips the trailing root dot", () => {
    assert.equal(normalizeNsHost("Dee.NS.Cloudflare.COM."), "dee.ns.cloudflare.com");
    assert.equal(normalizeNsHost("  ns1.example.net "), "ns1.example.net");
  });
});

describe("matchProvider", () => {
  const cases: [string, string][] = [
    ["dee.ns.cloudflare.com", "cloudflare"],
    ["red.foundationdns.com", "cloudflare"],
    ["dns1.registrar-servers.com", "namecheap"],
    ["ns45.domaincontrol.com", "godaddy"],
    ["ns-2048.awsdns-64.com", "route53"],
    ["ns-cloud-a1.googledomains.com", "google-cloud-dns"],
    ["ns1.digitalocean.com", "digitalocean"],
    ["ns1.vercel-dns.com", "vercel"],
    ["curitiba.ns.porkbun.com", "porkbun"],
    ["ns1.linode.com", "linode"],
    ["dns108.ovh.net", "ovh"],
    ["ns-207-a.gandi.net", "gandi"],
    ["ns1.name.com", "name-com"],
    ["ns1054.ui-dns.com", "ionos"],
    ["hydrogen.ns.hetzner.com", "hetzner"],
    ["ns1.first-ns.de", "hetzner"],
    ["robotns2.second-ns.de", "hetzner"]
  ];

  for (const [ns, expected] of cases) {
    it(`maps ${ns} to ${expected}`, () => {
      const p = matchProvider([ns], "example.com");
      assert.equal(p?.id, expected);
    });
  }

  it("matches case-insensitively and through trailing dots", () => {
    const p = matchProvider(["GAIL.NS.CLOUDFLARE.COM."], "example.com");
    assert.equal(p?.id, "cloudflare");
  });

  it("returns null for unknown nameservers", () => {
    assert.equal(matchProvider(["ns1.totally-unknown-dns.example"], "example.com"), null);
    assert.equal(matchProvider([], "example.com"), null);
  });

  it("does not match lookalike hosts that only share a suffix substring", () => {
    // "cloudflare.com" itself is not "*.ns.cloudflare.com".
    assert.equal(matchProvider(["cloudflare.com"], "example.com"), null);
    // A registrable domain merely containing a provider string.
    assert.equal(matchProvider(["ns1.notdomaincontrol.example"], "example.com"), null);
  });

  it("embeds the zone in provider console links where the console supports it", () => {
    const p = matchProvider(["dns1.registrar-servers.com"], "shop.example");
    assert.equal(
      p?.url,
      "https://ap.www.namecheap.com/domains/domaincontrolpanel/shop.example/advancedns"
    );
  });

  it("flags only providers with an API integration as apiSupported", () => {
    assert.equal(matchProvider(["dee.ns.cloudflare.com"], "x.com")?.apiSupported, true);
    assert.equal(matchProvider(["ns45.domaincontrol.com"], "x.com")?.apiSupported, false);
  });
});

describe("findZoneNameservers", () => {
  /** Resolver over a fixed zone map that records every queried name. */
  function fakeResolver(zones: Record<string, string[]>, queried: string[] = []) {
    const resolve = async (host: string): Promise<string[]> => {
      queried.push(host);
      const ns = zones[host];
      if (!ns) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      return ns;
    };
    return { resolve, queried };
  }

  it("walks from the full name up to the zone apex", async () => {
    const { resolve, queried } = fakeResolver({
      "example.com": ["dee.ns.cloudflare.com", "gail.ns.cloudflare.com"]
    });
    const found = await findZoneNameservers("app.example.com", resolve);
    assert.deepEqual(found, {
      zone: "example.com",
      nameservers: ["dee.ns.cloudflare.com", "gail.ns.cloudflare.com"]
    });
    assert.deepEqual(queried, ["app.example.com", "example.com"]);
  });

  it("answers at the first level that has NS records", async () => {
    // A delegated subdomain zone wins over its parent.
    const { resolve } = fakeResolver({
      "sub.example.com": ["ns1.digitalocean.com"],
      "example.com": ["dee.ns.cloudflare.com"]
    });
    const found = await findZoneNameservers("api.sub.example.com", resolve);
    assert.equal(found?.zone, "sub.example.com");
  });

  it("normalizes and sorts the returned nameservers", async () => {
    const { resolve } = fakeResolver({
      "example.com": ["GAIL.NS.CLOUDFLARE.COM.", "dee.ns.cloudflare.com"]
    });
    const found = await findZoneNameservers("example.com", resolve);
    assert.deepEqual(found?.nameservers, [
      "dee.ns.cloudflare.com",
      "gail.ns.cloudflare.com"
    ]);
  });

  it("never queries the bare TLD and returns null when nothing answers", async () => {
    const { resolve, queried } = fakeResolver({});
    const found = await findZoneNameservers("app.example.com", resolve);
    assert.equal(found, null);
    assert.ok(!queried.includes("com"), "must not query the bare TLD");
  });
});
