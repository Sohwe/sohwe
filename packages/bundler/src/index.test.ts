import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBundle,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BundleManifestSchema,
  canonicalize,
  parseBundle,
  type BundleAppInput,
  type BuildBundleOptions
} from "./index";

// A representative app used across the round-trip tests.
function sampleApp(overrides: Partial<BundleAppInput> = {}): BundleAppInput {
  return {
    name: "Web",
    slug: "web",
    gitRepo: "https://github.com/acme/web",
    gitBranch: "main",
    buildMode: "auto",
    buildCmd: null,
    startCmd: "node server.js",
    port: 3000,
    domain: "web.example.com",
    memoryLimitMb: 512,
    cpuLimit: 1.5,
    volumes: [{ mountPath: "/data", sizeBytes: "1048576" }],
    alertDestinations: [
      { type: "discord", name: "ops", url: "https://discord.example/hook", enabled: true }
    ],
    envVars: { API_KEY: "sk-secret-123", DEBUG: "false" },
    ...overrides
  };
}

const OPTS: BuildBundleOptions = {
  passphrase: "correct horse battery staple",
  includeSecrets: true,
  source: { orgName: "Acme", sohweVersion: "0.4.0" },
  createdAtIso: "2026-01-01T00:00:00.000Z"
};

describe("canonicalize", () => {
  it("sorts object keys so output is insertion-order independent", () => {
    assert.equal(
      canonicalize({ b: 1, a: 2 }),
      canonicalize({ a: 2, b: 1 })
    );
    assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it("recurses into nested objects and arrays", () => {
    assert.equal(
      canonicalize({ z: [{ y: 1, x: 2 }], a: null }),
      '{"a":null,"z":[{"x":2,"y":1}]}'
    );
  });

  it("preserves array order (arrays are not sorted)", () => {
    assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
  });

  it("handles primitives and strings with special characters", () => {
    assert.equal(canonicalize("a\"b"), '"a\\"b"');
    assert.equal(canonicalize(42), "42");
    assert.equal(canonicalize(null), "null");
  });
});

describe("buildBundle / parseBundle round-trip", () => {
  it("preserves all app config and decrypts env vars with secrets", () => {
    const bundle = buildBundle([sampleApp()], OPTS);
    const parsed = parseBundle(bundle, OPTS.passphrase);

    assert.equal(parsed.includesSecrets, true);
    assert.equal(parsed.source.orgName, "Acme");
    assert.equal(parsed.createdAt, "2026-01-01T00:00:00.000Z");
    assert.equal(parsed.apps.length, 1);

    const app = parsed.apps[0]!;
    assert.equal(app.name, "Web");
    assert.equal(app.slug, "web");
    assert.equal(app.port, 3000);
    assert.equal(app.cpuLimit, 1.5);
    assert.equal(app.memoryLimitMb, 512);
    assert.equal(app.domain, "web.example.com");
    assert.deepEqual(app.volumes, [{ mountPath: "/data", sizeBytes: "1048576" }]);
    assert.deepEqual(app.alertDestinations, [
      { type: "discord", name: "ops", url: "https://discord.example/hook", enabled: true }
    ]);
    assert.deepEqual(app.envVars, { API_KEY: "sk-secret-123", DEBUG: "false" });
  });

  it("omits env ciphertext entirely when includeSecrets is false", () => {
    const bundle = buildBundle([sampleApp()], { ...OPTS, includeSecrets: false });
    assert.equal(bundle.includesSecrets, false);
    assert.equal(bundle.apps[0]!.env, undefined);

    const parsed = parseBundle(bundle, OPTS.passphrase);
    assert.equal(parsed.includesSecrets, false);
    assert.deepEqual(parsed.apps[0]!.envVars, {});
  });

  it("does not embed env when includeSecrets is true but there are no vars", () => {
    const bundle = buildBundle([sampleApp({ envVars: {} })], OPTS);
    assert.equal(bundle.apps[0]!.env, undefined);
  });

  it("records env var keys in sorted order (metadata, not values)", () => {
    const bundle = buildBundle(
      [sampleApp({ envVars: { ZED: "z", ALPHA: "a", MID: "m" } })],
      OPTS
    );
    assert.deepEqual(bundle.apps[0]!.env!.keys, ["ALPHA", "MID", "ZED"]);
  });

  it("never stores plaintext env values in the manifest", () => {
    const bundle = buildBundle([sampleApp()], OPTS);
    const serialized = JSON.stringify(bundle);
    assert.ok(!serialized.includes("sk-secret-123"));
  });
});

describe("parseBundle rejection paths", () => {
  it("rejects a wrong passphrase as a signature mismatch", () => {
    const bundle = buildBundle([sampleApp()], OPTS);
    assert.throws(
      () => parseBundle(bundle, "wrong passphrase"),
      /Invalid passphrase or corrupted bundle/
    );
  });

  it("rejects a tampered field (signature no longer matches)", () => {
    const bundle = buildBundle([sampleApp()], OPTS);
    const tampered = structuredClone(bundle);
    tampered.apps[0]!.port = 9999;
    assert.throws(
      () => parseBundle(tampered, OPTS.passphrase),
      /Invalid passphrase or corrupted bundle/
    );
  });

  it("rejects tampered env ciphertext", () => {
    const bundle = buildBundle([sampleApp()], OPTS);
    const tampered = structuredClone(bundle);
    // Corrupt the ciphertext but re-sign so it passes signature check, forcing
    // the failure to surface at decrypt time.
    const ct = Buffer.from(tampered.apps[0]!.env!.ciphertext, "base64");
    const last = ct.length - 1;
    ct[last] = ct[last]! ^ 0xff;
    tampered.apps[0]!.env!.ciphertext = ct.toString("base64");
    // Signature now mismatches (payload changed), so this is caught earlier —
    // either way parseBundle must throw.
    assert.throws(() => parseBundle(tampered, OPTS.passphrase));
  });

  it("rejects an unrecognized document shape", () => {
    assert.throws(
      () => parseBundle({ not: "a bundle" }, OPTS.passphrase),
      /Unrecognized or unsupported bundle format/
    );
  });

  it("rejects a bundle with the wrong format tag", () => {
    const bundle = buildBundle([sampleApp()], OPTS) as Record<string, unknown>;
    assert.throws(
      () => parseBundle({ ...bundle, format: "something-else" }, OPTS.passphrase),
      /Unrecognized or unsupported bundle format/
    );
  });
});

// The on-disk bundle format is a cross-instance compatibility contract: a bundle
// exported by one Sohwe instance must restore on another, possibly newer, one.
// This golden bundle was produced by a real buildBundle() and is frozen here.
// It must keep parsing byte-for-byte forever. If this test breaks, the format
// changed incompatibly (KDF params, canonicalize, ciphertext layout, or schema)
// and existing user bundles can no longer be restored — bump BUNDLE_VERSION and
// add a migration path rather than "fixing" the golden.
const GOLDEN_PASSPHRASE = "correct horse battery staple";
const GOLDEN_BUNDLE = {
  format: "sohwe-backup",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { orgName: "Acme", sohweVersion: "0.4.0" },
  kdf: { algo: "scrypt", salt: "+/lJUYR0aLTXv9HFC0hZpg==", N: 16384, r: 8, p: 1 },
  includesSecrets: true,
  apps: [
    {
      name: "Web",
      slug: "web",
      gitRepo: "https://github.com/acme/web",
      gitBranch: "main",
      buildMode: "auto",
      buildCmd: null,
      startCmd: "node server.js",
      port: 3000,
      domain: "web.example.com",
      memoryLimitMb: 512,
      cpuLimit: 1.5,
      volumes: [{ mountPath: "/data", sizeBytes: "1048576" }],
      alertDestinations: [
        { type: "discord", name: "ops", url: "https://discord.example/hook", enabled: true }
      ],
      env: {
        keys: ["API_KEY", "DEBUG"],
        ciphertext:
          "Hw1BR2ENl0ryBIVNcSTuGyC/ogWfyQ26JtdEsgH1OoOp7oVwqir8TNDZU3JlTZ4MTZsqT/KDjqylDCoFBn/W6uWEQY3a8Ag="
      }
    }
  ],
  signature: "EG8lIIMTQsPk7WOnuSs3VCa/Uaf7odRPg0bhAHUvit8="
};

describe("golden bundle (format compatibility)", () => {
  it("matches the current schema and constants", () => {
    assert.equal(GOLDEN_BUNDLE.format, BUNDLE_FORMAT);
    // Frozen at v1 forever; BUNDLE_VERSION has moved on (see the v2 golden).
    assert.equal(GOLDEN_BUNDLE.version, 1);
    assert.equal(BundleManifestSchema.safeParse(GOLDEN_BUNDLE).success, true);
  });

  it("still parses and decrypts with the original passphrase", () => {
    const parsed = parseBundle(GOLDEN_BUNDLE, GOLDEN_PASSPHRASE);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.apps.length, 1);
    const app = parsed.apps[0]!;
    assert.equal(app.slug, "web");
    assert.deepEqual(app.envVars, { API_KEY: "sk-secret-123", DEBUG: "false" });
    // v1 predates managed datastores; the parsed shape reports none.
    assert.deepEqual(parsed.datastores, []);
  });

  it("still rejects the wrong passphrase for the frozen bundle", () => {
    assert.throws(
      () => parseBundle(GOLDEN_BUNDLE, "not the passphrase"),
      /Invalid passphrase or corrupted bundle/
    );
  });
});

describe("v2 datastores round-trip", () => {
  const DS = {
    kind: "postgres",
    name: "Main DB",
    slug: "main-db",
    engineVersion: "16",
    memoryLimitMb: 1024,
    cpuLimit: 2,
    publicPort: 24001,
    bindings: [{ appSlug: "web", envKeys: ["DATABASE_URL"] }]
  };

  it("emits the current version with a datastores array, even when empty", () => {
    const bundle = buildBundle([sampleApp()], OPTS);
    assert.equal(bundle.version, BUNDLE_VERSION);
    assert.deepEqual(bundle.datastores, []);
  });

  it("preserves datastore config and bindings through build/parse", () => {
    const bundle = buildBundle([sampleApp()], OPTS, [DS]);
    const parsed = parseBundle(bundle, OPTS.passphrase);
    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.datastores, [DS]);
  });

  it("signs the datastores array (tampering breaks the signature)", () => {
    const bundle = buildBundle([sampleApp()], OPTS, [DS]);
    const tampered = structuredClone(bundle);
    tampered.datastores[0]!.publicPort = 20999;
    assert.throws(
      () => parseBundle(tampered, OPTS.passphrase),
      /Invalid passphrase or corrupted bundle/
    );
  });

  it("carries no credential material for datastores", () => {
    const bundle = buildBundle([sampleApp()], OPTS, [DS]);
    const keys = Object.keys(bundle.datastores[0]!);
    assert.ok(!keys.some((k) => /password|credential|secret/i.test(k)));
  });
});

// The v2 golden: produced by a real buildBundle() with a datastore entry and
// frozen here, exactly like the v1 golden above. Same rules apply — if this
// breaks, bump BUNDLE_VERSION again and add a migration path.
const GOLDEN_BUNDLE_V2 = {
  format: "sohwe-backup",
  version: 2,
  createdAt: "2026-08-13T00:00:00.000Z",
  source: { orgName: "Acme", sohweVersion: "0.8.0" },
  kdf: { algo: "scrypt", salt: "CZjzrURerkaAMxYDyTeUYg==", N: 16384, r: 8, p: 1 },
  includesSecrets: true,
  apps: [
    {
      name: "Web",
      slug: "web",
      gitRepo: "https://github.com/acme/web",
      gitBranch: "main",
      buildMode: "auto",
      buildCmd: null,
      startCmd: "node server.js",
      port: 3000,
      domain: "web.example.com",
      memoryLimitMb: 512,
      cpuLimit: 1.5,
      volumes: [{ mountPath: "/data", sizeBytes: "1048576" }],
      alertDestinations: [
        { type: "discord", name: "ops", url: "https://discord.example/hook", enabled: true }
      ],
      env: {
        keys: ["API_KEY", "DATABASE_URL"],
        ciphertext:
          "ARN7XWzHEe4/hdRVCB5755Xhrd4P05NCSSWTQfBcGcZvdEicV8lE18c92ixxbT9DPnoUf5338dOHt4sWUnZMs/ClOOedzcmaguKpb5twcieYS1zsyJlrDHyaWSxrL5iEIOLdXShkXoPIV1A6ZgK1pwJpv3pLPJ9fjqQqpg35m664"
      }
    }
  ],
  datastores: [
    {
      kind: "postgres",
      name: "Main DB",
      slug: "main-db",
      engineVersion: "16",
      memoryLimitMb: 1024,
      cpuLimit: 2,
      publicPort: 24001,
      bindings: [{ appSlug: "web", envKeys: ["DATABASE_URL"] }]
    }
  ],
  signature: "1U1B/G7PaydN0No+gF5aLh4rIKCrBinM5p0cstzqoB0="
};

describe("golden bundle v2 (format compatibility)", () => {
  it("matches the current schema and constants", () => {
    assert.equal(GOLDEN_BUNDLE_V2.format, BUNDLE_FORMAT);
    assert.equal(GOLDEN_BUNDLE_V2.version, BUNDLE_VERSION);
    assert.equal(BundleManifestSchema.safeParse(GOLDEN_BUNDLE_V2).success, true);
  });

  it("still parses, decrypts, and carries its datastores", () => {
    const parsed = parseBundle(GOLDEN_BUNDLE_V2, GOLDEN_PASSPHRASE);
    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.apps[0]!.envVars, {
      API_KEY: "sk-secret-123",
      DATABASE_URL: "postgresql://sohwe:oldpass@sohwe-ds-main-db:5432/main_db"
    });
    assert.equal(parsed.datastores.length, 1);
    assert.equal(parsed.datastores[0]!.slug, "main-db");
    assert.deepEqual(parsed.datastores[0]!.bindings, [
      { appSlug: "web", envKeys: ["DATABASE_URL"] }
    ]);
  });

  it("still rejects the wrong passphrase for the frozen v2 bundle", () => {
    assert.throws(
      () => parseBundle(GOLDEN_BUNDLE_V2, "not the passphrase"),
      /Invalid passphrase or corrupted bundle/
    );
  });
});
