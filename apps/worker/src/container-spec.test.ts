import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appDockerVolumeName } from "@sohwe/types";
import {
  buildBinds,
  buildContainerSpec,
  buildHostRule,
  buildResourceLimits,
  buildTraefikLabels,
  containerNameFor,
  isPublicDomain,
  planHosts,
  resolveHosts,
  resolveRoutingConfig,
  shouldUseTls,
  traefikRouterName,
  type RoutingConfig,
  type SpecApp
} from "./container-spec";

/**
 * The container spec is the deploy's actual output: get a label wrong and the
 * app is unreachable, get TLS wrong and Traefik requests a certificate that can
 * never be issued. None of that shows up until something is deployed, so it is
 * asserted here directly.
 */

const APP: SpecApp = {
  id: "11111111-2222-3333-4444-555555555555",
  slug: "web",
  port: 3000,
  domains: [],
  memoryLimitMb: null,
  cpuLimit: null
};

const DEPLOYMENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** A custom domain entry; served directly unless a redirect target is given. */
const d = (hostname: string, redirectTo: string | null = null) => ({
  hostname,
  redirectTo
});

/** Router name for the fixture app, derived rather than hardcoded. */
const R = traefikRouterName(APP.slug);

const ROUTING: RoutingConfig = {
  baseDomain: "apps.example.com",
  network: "sohwe_proxy",
  httpsEnabled: false,
  certResolver: "letsencrypt"
};

function labels(
  app: Partial<SpecApp> = {},
  routing: Partial<RoutingConfig> = {}
): Record<string, string> {
  return buildTraefikLabels({
    app: { ...APP, ...app },
    deploymentId: DEPLOYMENT_ID,
    routing: { ...ROUTING, ...routing }
  });
}

describe("resolveRoutingConfig", () => {
  it("applies the documented defaults", () => {
    const c = resolveRoutingConfig({});
    assert.equal(c.baseDomain, "sohwe.localhost");
    assert.equal(c.network, "sohwe_proxy");
    assert.equal(c.httpsEnabled, false);
    assert.equal(c.certResolver, "letsencrypt");
  });

  it("reads each override", () => {
    const c = resolveRoutingConfig({
      SOHWE_BASE_DOMAIN: "apps.example.com",
      TRAEFIK_DOCKER_NETWORK: "custom_net",
      SOHWE_HTTPS_ENABLED: "true",
      SOHWE_CERT_RESOLVER: "dns-cloudflare"
    });
    assert.deepEqual(c, {
      baseDomain: "apps.example.com",
      network: "custom_net",
      httpsEnabled: true,
      certResolver: "dns-cloudflare"
    });
  });

  it("accepts TRUE for the HTTPS flag but not other truthy spellings", () => {
    assert.equal(resolveRoutingConfig({ SOHWE_HTTPS_ENABLED: "TRUE" }).httpsEnabled, true);
    for (const v of ["1", "yes", "on", ""]) {
      assert.equal(
        resolveRoutingConfig({ SOHWE_HTTPS_ENABLED: v }).httpsEnabled,
        false,
        `for ${JSON.stringify(v)}`
      );
    }
  });
});

describe("traefikRouterName", () => {
  it("never starts with a digit", () => {
    for (const slug of ["web", "2fast", "9"]) {
      assert.match(traefikRouterName(slug), /^w/);
    }
  });

  it("keeps a readable stem", () => {
    assert.match(traefikRouterName("web"), /^wweb/);
    assert.match(traefikRouterName("my-app"), /^wmyapp/);
  });

  it("emits only characters Traefik accepts", () => {
    assert.match(traefikRouterName("my-app_v2!"), /^[a-z0-9]+$/);
  });

  it("bounds the length", () => {
    assert.ok(traefikRouterName("a".repeat(200)).length <= 50);
  });

  it("is stable for a given slug", () => {
    assert.equal(traefikRouterName("web"), traefikRouterName("web"));
  });

  it("does not collide for slugs that differ only in punctuation", () => {
    // Both are valid slugs and can coexist in one organization. Sharing a
    // router name would let Traefik route one app's traffic to the other.
    for (const [a, b] of [
      ["my-app", "myapp"],
      ["web", "w-e-b"],
      ["a-b-c", "abc"],
      ["---", "-"]
    ] as const) {
      assert.notEqual(
        traefikRouterName(a),
        traefikRouterName(b),
        `${a} and ${b} collided`
      );
    }
  });

  it("stays distinct even when the readable stem is truncated", () => {
    const long = "a".repeat(60);
    assert.notEqual(traefikRouterName(`${long}-one`), traefikRouterName(`${long}-two`));
  });

  it("produces a usable name for a slug with no alphanumerics", () => {
    const name = traefikRouterName("---");
    assert.match(name, /^w[a-z0-9]+$/);
  });
});

describe("containerNameFor", () => {
  it("prefixes with sohwe-", () => {
    assert.equal(containerNameFor("web"), "sohwe-web");
  });

  it("replaces characters Docker rejects", () => {
    assert.equal(containerNameFor("my_app"), "sohwe-my-app");
  });

  it("stays within Docker's 63-character limit", () => {
    assert.ok(containerNameFor("a".repeat(200)).length <= 63);
  });

  it("produces a name Docker accepts", () => {
    assert.match(containerNameFor("web"), /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });
});

describe("resolveHosts", () => {
  it("always includes the generated subdomain", () => {
    assert.deepEqual(resolveHosts({ slug: "web", domains: [] }, "apps.example.com"), [
      "web.apps.example.com"
    ]);
  });

  it("adds every custom domain alongside it, in order", () => {
    assert.deepEqual(
      resolveHosts(
        { slug: "web", domains: [d("acme.com"), d("www.acme.com")] },
        "apps.example.com"
      ),
      ["web.apps.example.com", "acme.com", "www.acme.com"]
    );
  });

  it("includes redirecting hosts — they still need routing and a cert", () => {
    assert.deepEqual(
      resolveHosts(
        { slug: "web", domains: [d("acme.com"), d("www.acme.com", "acme.com")] },
        "apps.example.com"
      ),
      ["web.apps.example.com", "acme.com", "www.acme.com"]
    );
  });

  it("does not duplicate a custom domain equal to the generated one", () => {
    assert.deepEqual(
      resolveHosts(
        { slug: "web", domains: [d("web.apps.example.com")] },
        "apps.example.com"
      ),
      ["web.apps.example.com"]
    );
  });

  it("drops repeats and normalizes case", () => {
    // A repeated Host() term is not fatal to Traefik, but it is noise in the
    // rule and hints the caller passed the same domain twice.
    assert.deepEqual(
      resolveHosts(
        { slug: "web", domains: [d("Acme.COM"), d("acme.com"), d(" acme.com ")] },
        "apps.example.com"
      ),
      ["web.apps.example.com", "acme.com"]
    );
  });
});

describe("planHosts", () => {
  it("separates served hosts from redirecting ones", () => {
    assert.deepEqual(
      planHosts(
        { slug: "web", domains: [d("acme.com"), d("www.acme.com", "acme.com")] },
        "apps.example.com"
      ),
      {
        served: ["web.apps.example.com", "acme.com"],
        redirects: [{ from: "www.acme.com", to: "acme.com" }]
      }
    );
  });

  it("demotes a self-redirect to serving", () => {
    assert.deepEqual(
      planHosts(
        { slug: "web", domains: [d("acme.com", "acme.com")] },
        "apps.example.com"
      ),
      { served: ["web.apps.example.com", "acme.com"], redirects: [] }
    );
  });

  it("normalizes the redirect target's case", () => {
    const plan = planHosts(
      { slug: "web", domains: [d("acme.com"), d("www.acme.com", "Acme.COM")] },
      "apps.example.com"
    );
    assert.deepEqual(plan.redirects, [{ from: "www.acme.com", to: "acme.com" }]);
  });
});

describe("isPublicDomain", () => {
  it("accepts real domains", () => {
    for (const h of ["acme.com", "web.apps.example.com", "a.b.c.co.uk"]) {
      assert.equal(isPublicDomain(h), true, h);
    }
  });

  it("rejects hosts Let's Encrypt cannot issue for", () => {
    for (const h of ["localhost", "web.sohwe.localhost", "box.local"]) {
      assert.equal(isPublicDomain(h), false, h);
    }
  });
});

describe("shouldUseTls", () => {
  it("is off when the operator has not enabled HTTPS", () => {
    assert.equal(shouldUseTls(["acme.com"], false), false);
  });

  it("is off for a local-only host even when HTTPS is enabled", () => {
    // Requesting a cert for .localhost fails the challenge and burns quota.
    assert.equal(shouldUseTls(["web.sohwe.localhost"], true), false);
  });

  it("is on when any host is publicly issuable", () => {
    assert.equal(shouldUseTls(["web.sohwe.localhost", "acme.com"], true), true);
  });
});

describe("buildHostRule", () => {
  it("builds a single Host matcher", () => {
    assert.equal(buildHostRule(["acme.com"]), "Host(`acme.com`)");
  });

  it("ORs multiple hosts", () => {
    assert.equal(
      buildHostRule(["web.apps.example.com", "acme.com"]),
      "Host(`web.apps.example.com`) || Host(`acme.com`)"
    );
  });
});

describe("buildTraefikLabels", () => {
  it("marks the container as Sohwe-managed and traceable", () => {
    // App delete and the crash watcher both find containers by these labels.
    const l = labels();
    assert.equal(l["sohwe.managed"], "true");
    assert.equal(l["sohwe.app"], APP.id);
    assert.equal(l["sohwe.deployment"], DEPLOYMENT_ID);
  });

  it("routes to the app's port on Traefik's network", () => {
    const l = labels();
    assert.equal(l["traefik.enable"], "true");
    assert.equal(l["traefik.docker.network"], "sohwe_proxy");
    assert.equal(l[`traefik.http.services.${R}.loadbalancer.server.port`], "3000");
  });

  it("always exposes a plain HTTP router", () => {
    const l = labels();
    assert.equal(l[`traefik.http.routers.${R}.entrypoints`], "web");
    assert.equal(l[`traefik.http.routers.${R}.rule`], "Host(`web.apps.example.com`)");
    assert.equal(l[`traefik.http.routers.${R}.service`], R);
  });

  it("emits no TLS or redirect labels when HTTPS is off", () => {
    const l = labels();
    for (const key of Object.keys(l)) {
      assert.ok(!key.includes(".tls"), `unexpected TLS label ${key}`);
      assert.ok(!key.includes("middlewares"), `unexpected middleware label ${key}`);
    }
  });

  it("adds a websecure router and an HTTP redirect when TLS applies", () => {
    const l = labels({ domains: [d("acme.com")] }, { httpsEnabled: true });
    assert.equal(l[`traefik.http.routers.${R}s.entrypoints`], "websecure");
    assert.equal(l[`traefik.http.routers.${R}s.tls`], "true");
    assert.equal(l[`traefik.http.routers.${R}s.tls.certresolver`], "letsencrypt");
    // Both routers point at the one service, so HTTP and HTTPS reach the app.
    assert.equal(l[`traefik.http.routers.${R}s.service`], R);
    assert.equal(
      l[`traefik.http.middlewares.${R}-redirect.redirectscheme.scheme`],
      "https"
    );
    assert.equal(l[`traefik.http.routers.${R}.middlewares`], `${R}-redirect`);
  });

  it("uses the configured cert resolver", () => {
    const l = labels(
      { domains: [d("acme.com")] },
      { httpsEnabled: true, certResolver: "dns-cloudflare" }
    );
    assert.equal(l[`traefik.http.routers.${R}s.tls.certresolver`], "dns-cloudflare");
  });

  it("gives both routers the same host rule", () => {
    const l = labels({ domains: [d("acme.com")] }, { httpsEnabled: true });
    assert.equal(l[`traefik.http.routers.${R}.rule`], l[`traefik.http.routers.${R}s.rule`]);
    assert.match(l[`traefik.http.routers.${R}.rule`] ?? "", /acme\.com/);
  });

  it("gives two punctuation-only-different slugs disjoint label sets", () => {
    // The regression this guards: identical router names would make Traefik
    // hold conflicting definitions for one router across two containers.
    const a = labels({ slug: "my-app" });
    const b = labels({ slug: "myapp" });
    const routerKeys = (l: Record<string, string>) =>
      Object.keys(l).filter((k) => k.startsWith("traefik.http."));
    const shared = routerKeys(a).filter((k) => routerKeys(b).includes(k));
    assert.deepEqual(shared, [], `shared Traefik keys: ${shared.join(", ")}`);
  });

  it("does not request a certificate for a localhost-only app", () => {
    const l = labels({}, { baseDomain: "sohwe.localhost", httpsEnabled: true });
    assert.ok(!Object.keys(l).some((k) => k.includes("certresolver")));
  });

  /** Router names of the redirect routers in a label set (no TLS suffix). */
  const redirectRouters = (l: Record<string, string>) => {
    const re = new RegExp(`^traefik\\.http\\.routers\\.(${R}rd[0-9a-f]{8})\\.rule$`);
    return Object.keys(l)
      .map((k) => re.exec(k)?.[1])
      .filter((n): n is string => n !== undefined);
  };

  it("answers a redirecting host with a redirect router, not the app rule", () => {
    const l = labels({
      domains: [d("acme.com"), d("www.acme.com", "acme.com")]
    });
    // The served rule must not claim the redirecting host, or the two routers
    // would race for it.
    assert.equal(
      l[`traefik.http.routers.${R}.rule`],
      "Host(`web.apps.example.com`) || Host(`acme.com`)"
    );

    const [name, ...rest] = redirectRouters(l);
    assert.ok(name, "expected a redirect router");
    assert.deepEqual(rest, []);
    assert.equal(l[`traefik.http.routers.${name}.rule`], "Host(`www.acme.com`)");
    assert.equal(l[`traefik.http.routers.${name}.entrypoints`], "web");
    assert.equal(l[`traefik.http.routers.${name}.middlewares`], `${name}-to`);
    assert.equal(
      l[`traefik.http.middlewares.${name}-to.redirectregex.regex`],
      "^https?://www\\.acme\\.com/(.*)"
    );
    // HTTPS is off on this instance, so the redirect lands on plain http.
    assert.equal(
      l[`traefik.http.middlewares.${name}-to.redirectregex.replacement`],
      "http://acme.com/${1}"
    );
    assert.equal(
      l[`traefik.http.middlewares.${name}-to.redirectregex.permanent`],
      "true"
    );
  });

  it("gives a redirecting host a certificate and an https target under TLS", () => {
    const l = labels(
      { domains: [d("acme.com"), d("www.acme.com", "acme.com")] },
      { httpsEnabled: true }
    );
    const [name] = redirectRouters(l);
    assert.ok(name, "expected a redirect router");
    // `https://www.acme.com` must present a valid cert before redirecting.
    assert.equal(l[`traefik.http.routers.${name}s.entrypoints`], "websecure");
    assert.equal(l[`traefik.http.routers.${name}s.tls`], "true");
    assert.equal(l[`traefik.http.routers.${name}s.tls.certresolver`], "letsencrypt");
    assert.equal(l[`traefik.http.routers.${name}s.middlewares`], `${name}-to`);
    // One hop: http://www → https://apex directly, not via the scheme upgrade.
    assert.equal(
      l[`traefik.http.middlewares.${name}-to.redirectregex.replacement`],
      "https://acme.com/${1}"
    );
  });
});

describe("buildBinds", () => {
  it("maps each volume to its documented Docker name", () => {
    const binds = buildBinds(APP.id, [
      { id: "v1", mountPath: "/data" },
      { id: "v2", mountPath: "/cache" }
    ]);
    assert.deepEqual(binds, [
      `${appDockerVolumeName(APP.id, "v1")}:/data`,
      `${appDockerVolumeName(APP.id, "v2")}:/cache`
    ]);
  });

  it("is empty when the app has no volumes", () => {
    assert.deepEqual(buildBinds(APP.id, []), []);
  });
});

describe("buildResourceLimits", () => {
  it("converts megabytes to bytes and cores to nanocpus", () => {
    assert.deepEqual(buildResourceLimits({ memoryLimitMb: 512, cpuLimit: 1.5 }), {
      Memory: 512 * 1024 * 1024,
      NanoCpus: 1_500_000_000
    });
  });

  it("leaves an unset limit undefined rather than zero", () => {
    const l = buildResourceLimits({ memoryLimitMb: null, cpuLimit: null });
    assert.equal(l.Memory, undefined);
    assert.equal(l.NanoCpus, undefined);
  });

  it("rounds fractional cpu to a whole nanocpu count", () => {
    assert.equal(buildResourceLimits({ memoryLimitMb: null, cpuLimit: 0.1 }).NanoCpus, 100_000_000);
    assert.ok(
      Number.isInteger(buildResourceLimits({ memoryLimitMb: null, cpuLimit: 0.3 }).NanoCpus)
    );
  });
});

describe("buildContainerSpec", () => {
  const spec = (over: {
    app?: Partial<SpecApp>;
    routing?: Partial<RoutingConfig>;
    envList?: string[];
    volumes?: { id: string; mountPath: string }[];
  } = {}) =>
    buildContainerSpec({
      app: { ...APP, ...over.app },
      deploymentId: DEPLOYMENT_ID,
      imageTag: "sohwe/app-web:dep-1",
      volumes: over.volumes ?? [],
      envList: over.envList ?? [],
      routing: { ...ROUTING, ...over.routing }
    });

  it("names the container and image", () => {
    const s = spec();
    assert.equal(s.name, "sohwe-web");
    assert.equal(s.Image, "sohwe/app-web:dep-1");
  });

  it("exposes the app's port", () => {
    assert.deepEqual(spec({ app: { port: 8080 } }).ExposedPorts, { "8080/tcp": {} });
  });

  it("joins Traefik's network and restarts unless stopped", () => {
    const host = spec().HostConfig;
    assert.equal(host?.NetworkMode, "sohwe_proxy");
    assert.deepEqual(host?.RestartPolicy, { Name: "unless-stopped" });
  });

  it("omits Env entirely when the app has none", () => {
    // `Env: []` and `Env: undefined` are equivalent to Docker, but omitting it
    // keeps the request identical to what a no-env app has always sent.
    assert.equal(spec().Env, undefined);
  });

  it("passes decrypted env through verbatim", () => {
    assert.deepEqual(spec({ envList: ["A=1", "B=two"] }).Env, ["A=1", "B=two"]);
  });

  it("omits Binds when there are no volumes", () => {
    assert.equal(spec().HostConfig?.Binds, undefined);
  });

  it("mounts each volume", () => {
    const s = spec({ volumes: [{ id: "v1", mountPath: "/data" }] });
    assert.deepEqual(s.HostConfig?.Binds, [`${appDockerVolumeName(APP.id, "v1")}:/data`]);
  });

  it("applies resource limits when set", () => {
    const host = spec({ app: { memoryLimitMb: 256, cpuLimit: 2 } }).HostConfig;
    assert.equal(host?.Memory, 256 * 1024 * 1024);
    assert.equal(host?.NanoCpus, 2_000_000_000);
  });

  it("carries the same labels buildTraefikLabels produces", () => {
    assert.deepEqual(spec().Labels, labels());
  });

  it("produces a spec that is JSON-serializable for the Docker API", () => {
    assert.doesNotThrow(() => JSON.stringify(spec({ envList: ["A=1"] })));
  });
});
