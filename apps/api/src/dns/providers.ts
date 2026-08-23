import type { DnsProviderInfo } from "@sohwe/types";

// Curated registry mapping nameserver hostnames to DNS providers (Phase 8).
// Pure module: the NS lookup itself is injected, so tests run against a fake
// resolver and this file never touches the network.
//
// Matching is on the *DNS host*, not the registrar — a Namecheap-registered
// domain using Cloudflare nameservers matches Cloudflare, which is correct:
// records must be added where the NS records point. Unknown nameservers return
// no provider and the UI falls back to showing them raw.

type ProviderDef = {
  id: string;
  name: string;
  /** Tested against each normalized (lowercased, no trailing dot) NS host. */
  nsPattern: RegExp;
  /** DNS console deep link; `zone` is the detected zone apex. */
  dnsUrl: (zone: string) => string;
  /** True when Sohwe can write records through this provider's API. */
  apiSupported: boolean;
};

const PROVIDERS: readonly ProviderDef[] = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    // Standard assigned nameservers, plus the Foundation DNS ("advanced"
    // nameserver) domains Cloudflare uses for enterprise zones.
    nsPattern: /\.ns\.cloudflare\.com$|\.foundationdns\.(?:com|net|org)$/,
    // `:account` is Cloudflare's own placeholder — the dashboard fills in
    // whichever account the signed-in user has. Substituting the real zone
    // lands on that zone's DNS tab instead of the zone picker.
    dnsUrl: (zone) => `https://dash.cloudflare.com/?to=/:account/${zone}/dns`,
    apiSupported: true
  },
  {
    id: "namecheap",
    name: "Namecheap",
    nsPattern: /\.registrar-servers\.com$/,
    dnsUrl: (zone) =>
      `https://ap.www.namecheap.com/domains/domaincontrolpanel/${zone}/advancedns`,
    apiSupported: false
  },
  {
    id: "godaddy",
    name: "GoDaddy",
    nsPattern: /\.domaincontrol\.com$/,
    dnsUrl: (zone) => `https://dcc.godaddy.com/manage/${zone}/dns`,
    apiSupported: false
  },
  {
    id: "route53",
    name: "Amazon Route 53",
    nsPattern: /\.awsdns-\d+\.(?:com|net|org|co\.uk)$/,
    dnsUrl: () => "https://console.aws.amazon.com/route53/v2/hostedzones",
    apiSupported: false
  },
  {
    id: "google-cloud-dns",
    name: "Google Cloud DNS",
    nsPattern: /\.googledomains\.com$/,
    dnsUrl: () => "https://console.cloud.google.com/net-services/dns/zones",
    apiSupported: false
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    nsPattern: /^ns\d\.digitalocean\.com$/,
    dnsUrl: (zone) => `https://cloud.digitalocean.com/networking/domains/${zone}`,
    apiSupported: true
  },
  {
    id: "vercel",
    name: "Vercel",
    nsPattern: /\.vercel-dns\.com$/,
    dnsUrl: () => "https://vercel.com/dashboard/domains",
    apiSupported: false
  },
  {
    id: "porkbun",
    name: "Porkbun",
    nsPattern: /\.ns\.porkbun\.com$/,
    dnsUrl: () => "https://porkbun.com/account/domainsSpeedy",
    apiSupported: false
  },
  {
    id: "linode",
    name: "Linode / Akamai",
    nsPattern: /^ns\d\.linode\.com$/,
    dnsUrl: () => "https://cloud.linode.com/domains",
    apiSupported: false
  },
  {
    id: "ovh",
    name: "OVH",
    nsPattern: /\.ovh\.(?:net|ca)$/,
    dnsUrl: () => "https://www.ovh.com/manager/",
    apiSupported: false
  },
  {
    id: "gandi",
    name: "Gandi",
    nsPattern: /\.gandi\.net$/,
    dnsUrl: (zone) => `https://admin.gandi.net/domain/${zone}`,
    apiSupported: false
  },
  {
    id: "name-com",
    name: "Name.com",
    nsPattern: /\.name\.com$/,
    dnsUrl: (zone) => `https://www.name.com/account/domain/details/${zone}#dns`,
    apiSupported: false
  },
  {
    id: "ionos",
    name: "IONOS",
    nsPattern: /\.ui-dns\.(?:com|de|org|biz)$/,
    dnsUrl: () => "https://my.ionos.com/domains",
    apiSupported: false
  },
  {
    id: "hetzner",
    name: "Hetzner",
    nsPattern: /\.ns\.hetzner\.(?:com|de)$|^ns\d\.first-ns\.de$|^robotns\d\.second-ns\.(?:de|com)$/,
    // Hetzner addresses zones by opaque id, which is not known before an API
    // call, so this can only reach the zone list.
    dnsUrl: () => "https://dns.hetzner.com/",
    apiSupported: true
  }
];

/** Lowercase and strip the trailing root dot some resolvers return. */
export function normalizeNsHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Match a set of nameservers to a provider. All nameservers of a zone normally
 * belong to one provider, so the first match wins.
 */
export function matchProvider(
  nameservers: string[],
  zone: string
): DnsProviderInfo | null {
  for (const ns of nameservers.map(normalizeNsHost)) {
    for (const p of PROVIDERS) {
      if (p.nsPattern.test(ns)) {
        return {
          id: p.id,
          name: p.name,
          url: p.dnsUrl(zone),
          apiSupported: p.apiSupported
        };
      }
    }
  }
  return null;
}

/** NS lookup signature, satisfied by `dns.promises.Resolver#resolveNs`. */
export type NsLookup = (host: string) => Promise<string[]>;

/**
 * Find the zone apex holding a domain's NS records by walking label by label
 * toward the root: `app.example.com` → `example.com` → stop. NS queries on a
 * name below the zone cut return no data, so the first level that answers is
 * the zone. The bare TLD is never queried (the walk stops at two labels), and
 * lookup errors at one level just move the walk up.
 */
export async function findZoneNameservers(
  domain: string,
  resolveNs: NsLookup
): Promise<{ zone: string; nameservers: string[] } | null> {
  const labels = domain.toLowerCase().split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join(".");
    try {
      const ns = await resolveNs(candidate);
      if (ns.length > 0) {
        return { zone: candidate, nameservers: ns.map(normalizeNsHost).sort() };
      }
    } catch {
      // ENODATA/ENOTFOUND below the zone cut — try the parent.
    }
  }
  return null;
}
