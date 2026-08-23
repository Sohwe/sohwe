// Registry of the DNS providers Sohwe can write records through.
//
// Adding a provider is: implement `DnsDriver`, register it here, add its id to
// `DNS_API_PROVIDERS` in `@sohwe/types`, and flip `apiSupported` on its entry
// in the detection registry (`providers.ts`). Nothing else in the API or the
// dashboard hardcodes a provider name.

import type { DnsApiProvider } from "@sohwe/types";
import { cloudflareDriver } from "./cloudflare";
import { digitalOceanDriver } from "./digitalocean";
import { hetznerDriver } from "./hetzner";
import type { DnsDriver } from "./driver";

const DRIVERS: Record<DnsApiProvider, DnsDriver> = {
  cloudflare: cloudflareDriver,
  digitalocean: digitalOceanDriver,
  hetzner: hetznerDriver
};

export function getDnsDriver(provider: DnsApiProvider): DnsDriver {
  return DRIVERS[provider];
}

export function listDnsDrivers(): DnsDriver[] {
  return Object.values(DRIVERS);
}
