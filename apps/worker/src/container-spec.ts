import { createHash } from "node:crypto";
import type Docker from "dockerode";
import { appDockerVolumeName } from "@sohwe/types";

/**
 * How a deployed app becomes a Docker container.
 *
 * This is the part of the deploy that is a pure decision — given the app row,
 * its volumes, and the instance's routing settings, produce the exact object
 * handed to `docker.createContainer`. Keeping it separate from `runDeploy`
 * means the routing labels, resource limits, mounts, and network attachment can
 * be tested directly, instead of only being observable by deploying something
 * and looking at Traefik.
 *
 * Nothing here performs I/O or reads `process.env`; the caller resolves both.
 */

export type RoutingConfig = {
  /** Parent domain for the generated `<slug>.<base>` host. */
  baseDomain: string;
  /** Traefik's docker network, which app containers must join to be routed. */
  network: string;
  /** Operator opt-in; TLS labels are only emitted when this is true. */
  httpsEnabled: boolean;
  /** Traefik ACME resolver named on the TLS labels. */
  certResolver: string;
};

export type SpecApp = {
  id: string;
  slug: string;
  port: number;
  /** Custom hostnames, in the order they should appear in the Traefik rule. */
  domains: string[];
  memoryLimitMb: number | null;
  cpuLimit: number | null;
};

export type SpecVolume = { id: string; mountPath: string };

/** Read the routing settings from an environment, applying the defaults. */
export function resolveRoutingConfig(
  env: NodeJS.ProcessEnv = process.env
): RoutingConfig {
  return {
    baseDomain: env.SOHWE_BASE_DOMAIN ?? "sohwe.localhost",
    network: env.TRAEFIK_DOCKER_NETWORK ?? "sohwe_proxy",
    httpsEnabled: (env.SOHWE_HTTPS_ENABLED ?? "").toLowerCase() === "true",
    certResolver: env.SOHWE_CERT_RESOLVER ?? "letsencrypt"
  };
}

/** Length of the disambiguating digest appended to a Traefik router name. */
const ROUTER_DIGEST_LEN = 8;
/** Room left for the readable part, keeping the whole name under 50 chars. */
const ROUTER_STEM_MAX = 40;

/**
 * Traefik router/service name for an app. Traefik names must be simple and must
 * not start with a digit, hence the leading `w`.
 *
 * The readable stem alone is not enough: stripping non-alphanumerics is lossy,
 * so `my-app` and `myapp` — two distinct, individually valid slugs — both
 * reduce to `wmyapp`. Two apps sharing a router name means Traefik holds
 * conflicting definitions for it and can route one app's traffic to the other,
 * so a digest of the *full* slug is appended to keep names distinct.
 */
export function traefikRouterName(slug: string): string {
  const stem = `w${slug.replace(/[^a-z0-9]/g, "")}`.slice(0, ROUTER_STEM_MAX);
  const digest = createHash("sha256")
    .update(slug)
    .digest("hex")
    .slice(0, ROUTER_DIGEST_LEN);
  return `${stem}${digest}`;
}

/** Docker container name for an app. Docker caps names at 63 characters. */
export function containerNameFor(slug: string): string {
  return `sohwe-${slug}`.replace(/[^a-z0-9-]/g, "-").slice(0, 63) || "sohwe-app";
}

/**
 * Hosts this app answers on: always the generated subdomain, plus every custom
 * domain attached to it.
 *
 * The generated host stays first and duplicates are dropped — a custom domain
 * equal to the generated one, or listed twice, would otherwise emit a repeated
 * `Host()` term in the router rule.
 */
export function resolveHosts(
  app: { slug: string; domains: string[] },
  baseDomain: string
): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const host of [`${app.slug}.${baseDomain}`, ...app.domains]) {
    const normalized = host.trim().toLowerCase();
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    hosts.push(normalized);
  }
  return hosts;
}

/**
 * Whether a host is one Let's Encrypt could actually issue for. Requesting a
 * certificate for `.localhost` fails the ACME challenge and, repeated, walks
 * into Let's Encrypt's failure rate limit.
 */
export function isPublicDomain(host: string): boolean {
  return (
    !host.endsWith(".localhost") && !host.endsWith(".local") && host !== "localhost"
  );
}

/** TLS is on only when the operator enabled it *and* a host can be issued for. */
export function shouldUseTls(hosts: string[], httpsEnabled: boolean): boolean {
  return httpsEnabled && hosts.some(isPublicDomain);
}

export function buildHostRule(hosts: string[]): string {
  return hosts.map((h) => `Host(\`${h}\`)`).join(" || ");
}

/**
 * Traefik labels for an app container.
 *
 * An HTTP router is always present. When TLS applies, a second router is added
 * on `websecure` and the plain router gains a redirect middleware, so HTTP
 * traffic is upgraded rather than served.
 */
export function buildTraefikLabels(input: {
  app: SpecApp;
  deploymentId: string;
  routing: RoutingConfig;
}): Record<string, string> {
  const { app, deploymentId, routing } = input;
  const router = traefikRouterName(app.slug);
  const hosts = resolveHosts(app, routing.baseDomain);
  const hostRule = buildHostRule(hosts);
  const useTls = shouldUseTls(hosts, routing.httpsEnabled);

  const labels: Record<string, string> = {
    "traefik.enable": "true",
    "traefik.docker.network": routing.network,
    [`traefik.http.services.${router}.loadbalancer.server.port`]: String(app.port),
    "sohwe.managed": "true",
    "sohwe.app": app.id,
    "sohwe.deployment": deploymentId,
    [`traefik.http.routers.${router}.rule`]: hostRule,
    [`traefik.http.routers.${router}.entrypoints`]: "web",
    [`traefik.http.routers.${router}.service`]: router
  };

  if (useTls) {
    const secure = `${router}s`;
    labels[`traefik.http.routers.${secure}.rule`] = hostRule;
    labels[`traefik.http.routers.${secure}.entrypoints`] = "websecure";
    labels[`traefik.http.routers.${secure}.service`] = router;
    labels[`traefik.http.routers.${secure}.tls`] = "true";
    labels[`traefik.http.routers.${secure}.tls.certresolver`] = routing.certResolver;

    const mw = `${router}-redirect`;
    labels[`traefik.http.middlewares.${mw}.redirectscheme.scheme`] = "https";
    labels[`traefik.http.middlewares.${mw}.redirectscheme.permanent`] = "true";
    labels[`traefik.http.routers.${router}.middlewares`] = mw;
  }

  return labels;
}

/** `<docker volume>:<mount path>` binds for an app's named volumes. */
export function buildBinds(appId: string, volumes: SpecVolume[]): string[] {
  return volumes.map((v) => `${appDockerVolumeName(appId, v.id)}:${v.mountPath}`);
}

/**
 * Docker's resource fields for an app's limits. Both are optional: an unset
 * limit must be `undefined` rather than 0, which Docker reads as "unlimited"
 * only by accident of the API and is better left absent.
 */
export function buildResourceLimits(app: {
  memoryLimitMb: number | null;
  cpuLimit: number | null;
}): { Memory?: number; NanoCpus?: number } {
  return {
    Memory: app.memoryLimitMb ? app.memoryLimitMb * 1024 * 1024 : undefined,
    NanoCpus: app.cpuLimit ? Math.round(Number(app.cpuLimit) * 1e9) : undefined
  };
}

/** The complete argument for `docker.createContainer`. */
export function buildContainerSpec(input: {
  app: SpecApp;
  deploymentId: string;
  imageTag: string;
  volumes: SpecVolume[];
  /** Already-decrypted `KEY=value` strings, or empty when the app has none. */
  envList: string[];
  routing: RoutingConfig;
}): Docker.ContainerCreateOptions {
  const { app, deploymentId, imageTag, volumes, envList, routing } = input;
  const binds = buildBinds(app.id, volumes);

  return {
    name: containerNameFor(app.slug),
    Image: imageTag,
    Labels: buildTraefikLabels({ app, deploymentId, routing }),
    ExposedPorts: { [`${app.port}/tcp`]: {} },
    Env: envList.length > 0 ? envList : undefined,
    HostConfig: {
      NetworkMode: routing.network,
      RestartPolicy: { Name: "unless-stopped" },
      Binds: binds.length > 0 ? binds : undefined,
      ...buildResourceLimits(app)
    }
  };
}
