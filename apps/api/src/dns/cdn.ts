/**
 * Recognizing a reverse-proxy edge address.
 *
 * A custom domain has to point at *this server*. When the apps base domain is
 * itself behind a proxy (Cloudflare's orange cloud, most often), resolving it
 * hands back an edge address rather than the origin — and pointing a customer
 * domain at that address makes the proxy fetch its origin from itself. Cloudflare
 * detects the loop and serves "Error 1000: DNS points to prohibited IP".
 *
 * Worse, it verifies clean: the domain resolves to exactly the address Sohwe
 * expected, so a naive comparison reports success over a site that is down.
 * Every place an address is treated as an origin runs it past `cdnForAddress`
 * first.
 *
 * This is a correctness guard, not a security boundary — a stale range only
 * costs a missed warning, never a wrong route.
 */

/**
 * Cloudflare's published IPv4 ranges (`https://api.cloudflare.com/client/v4/ips`,
 * etag 38f79d050aa027e3be3865e495dcc9bc). These have been stable for years;
 * refresh them if Cloudflare announces a new block.
 */
const CLOUDFLARE_IPV4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22"
] as const;

/** Proxy networks whose addresses can never be an origin, by display name. */
const PROXY_NETWORKS: readonly { name: string; cidrs: readonly string[] }[] = [
  { name: "Cloudflare", cidrs: CLOUDFLARE_IPV4 }
];

/** Dotted-quad to a 32-bit unsigned integer, or null if it is not one. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    // Only plain decimal octets. Leading zeros are rejected on purpose: some
    // parsers read "010" as octal, and a value that means two different things
    // to two readers has no place in an origin check.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  // `<<` yields a signed 32-bit value; shift back into unsigned space.
  return out >>> 0;
}

/** True when `ip` falls inside `cidr`. Both must be IPv4. */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash === -1) return false;
  const base = ipv4ToInt(cidr.slice(0, slash));
  const bits = Number(cidr.slice(slash + 1));
  const addr = ipv4ToInt(ip);
  if (base === null || addr === null) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  // A /0 mask would overflow the shift; it matches everything by definition.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) >>> 0 === (base & mask) >>> 0;
}

/**
 * The proxy network holding `ip` ("Cloudflare"), or null when the address
 * could be a real origin. Anything that is not a parseable IPv4 address is
 * null: this answers "is this a known edge", not "is this valid".
 */
export function cdnForAddress(ip: string): string | null {
  for (const network of PROXY_NETWORKS) {
    for (const cidr of network.cidrs) {
      if (ipv4InCidr(ip, cidr)) return network.name;
    }
  }
  return null;
}
