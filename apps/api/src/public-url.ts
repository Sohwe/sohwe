import type { FastifyRequest } from "fastify";
import type { ApiConfig } from "./env";

/**
 * Externally reachable origin for this instance. `SOHWE_PUBLIC_URL` wins; the
 * request's forwarded host is a best-effort fallback so a plain install works
 * without another env var.
 *
 * Used by the GitHub App manifest flow (where a wrong origin bakes a dead
 * webhook URL into the App) and by invitation join links.
 */
export function publicBaseUrl(req: FastifyRequest, config: ApiConfig): string {
  if (config.publicUrl) return config.publicUrl;
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const hostname = Array.isArray(host) ? host[0] : host;
  const proto = config.httpsEnabled ? "https" : req.protocol;
  return `${proto}://${hostname ?? "localhost"}`;
}
