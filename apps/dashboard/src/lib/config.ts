import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./api";

// Operator-driven runtime config served by the API at GET /api/config. Right
// now this is just the apps' base domain (the worker uses the same value to
// label app containers in Traefik). Was previously a hardcoded constant in
// `lib/constants.ts`; that didn't survive operators picking a real DNS name
// for `SOHWE_BASE_DOMAIN`, since the dashboard image is built once at
// release time but the domain is per-install.
export type AppConfig = {
  baseDomain: string;
};

// Fallback used while the query is loading or if the API is briefly
// unreachable. Same default as the API + worker so display + routing match
// when nothing else is configured. Prefer rendering this rather than
// blocking the UI on a config fetch — the URLs are informational, the
// dashboard works with the wrong placeholder for a few hundred ms.
const FALLBACK: AppConfig = {
  baseDomain: "sohwe.localhost"
};

export function useAppConfig(): AppConfig {
  const q = useQuery({
    queryKey: ["config"],
    queryFn: () => apiGet<AppConfig>("/api/config"),
    // Config is set at install time and only changes on an operator restart;
    // there's no value in re-fetching during a session.
    staleTime: Infinity,
    gcTime: Infinity
  });
  return q.data ?? FALLBACK;
}

/** Convenience for the common case — most call sites only need the domain. */
export function useBaseDomain(): string {
  return useAppConfig().baseDomain;
}
