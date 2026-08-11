import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// resolveDestination decrypts stored S3 credentials, so the instance key has to
// exist before the module's crypto dependency is first used.
process.env.SOHWE_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
// `./export` pulls in the Prisma client, which is constructed at import time.
// Nothing here queries, so an unreachable URL is enough to satisfy it.
process.env.DATABASE_URL ??= "postgresql://sohwe:pw@127.0.0.1:1/unused";

const { encryptJson } = await import("@sohwe/crypto");
const { describeDestination, resolveDestination, BUNDLE_FILE_SUFFIX } = await import(
  "./storage"
);
const { makeBundleFilename } = await import("./export");

/**
 * `resolveDestination` turns an untrusted database row into the thing that
 * decides where a backup is written and with whose credentials, so every
 * malformed shape must throw rather than silently produce a half-configured
 * client. `describeDestination` is rendered into logs and UI, so it must never
 * carry the credentials it sits next to.
 */

const CREDS = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3t-key-value" };

function s3Row(config: Record<string, unknown>, secret = CREDS) {
  return {
    kind: "s3",
    config,
    secretEncrypted: encryptJson(secret)
  };
}

/** A row with no stored credentials, as every local destination has. */
function row(kind: string, config: unknown) {
  return { kind, config, secretEncrypted: null };
}

describe("resolveDestination — local", () => {
  it("resolves a path", () => {
    const dest = resolveDestination(row("local", { path: "/var/backups" }));
    assert.deepEqual(dest, { kind: "local", path: "/var/backups" });
  });

  it("throws when the path is missing or not a string", () => {
    assert.throws(() => resolveDestination(row("local", {})), /missing a path/);
    assert.throws(() => resolveDestination(row("local", null)), /missing a path/);
    assert.throws(() => resolveDestination(row("local", { path: 42 })), /missing a path/);
  });
});

describe("resolveDestination — s3", () => {
  it("resolves bucket, region, and decrypted credentials", () => {
    const dest = resolveDestination(s3Row({ bucket: "b", region: "us-east-1" }));
    assert.equal(dest.kind, "s3");
    assert.ok(dest.kind === "s3");
    assert.equal(dest.bucket, "b");
    assert.equal(dest.region, "us-east-1");
    assert.equal(dest.accessKeyId, CREDS.accessKeyId);
    assert.equal(dest.secretAccessKey, CREDS.secretAccessKey);
  });

  it("carries the optional MinIO/R2 settings through", () => {
    const dest = resolveDestination(
      s3Row({
        bucket: "b",
        region: "auto",
        endpoint: "https://minio.test:9000",
        prefix: "backups",
        forcePathStyle: true
      })
    );
    assert.ok(dest.kind === "s3");
    assert.equal(dest.endpoint, "https://minio.test:9000");
    assert.equal(dest.prefix, "backups");
    assert.equal(dest.forcePathStyle, true);
  });

  it("defaults forcePathStyle to false unless it is exactly true", () => {
    for (const forcePathStyle of [undefined, "true", 1, null]) {
      const dest = resolveDestination(
        s3Row({ bucket: "b", region: "r", forcePathStyle })
      );
      assert.ok(dest.kind === "s3");
      assert.equal(dest.forcePathStyle, false, `for ${String(forcePathStyle)}`);
    }
  });

  it("throws when bucket or region is missing", () => {
    assert.throws(() => resolveDestination(s3Row({ region: "r" })), /bucket or region/);
    assert.throws(() => resolveDestination(s3Row({ bucket: "b" })), /bucket or region/);
    assert.throws(() => resolveDestination(s3Row({})), /bucket or region/);
  });

  it("throws when credentials are absent", () => {
    assert.throws(
      () =>
        resolveDestination({
          kind: "s3",
          config: { bucket: "b", region: "r" },
          secretEncrypted: null
        }),
      /missing stored credentials/i
    );
    assert.throws(
      () =>
        resolveDestination({
          kind: "s3",
          config: { bucket: "b", region: "r" },
          secretEncrypted: Buffer.alloc(0)
        }),
      /missing stored credentials/i
    );
  });

  it("throws when the decrypted credentials are incomplete", () => {
    assert.throws(
      () => resolveDestination(s3Row({ bucket: "b", region: "r" }, { accessKeyId: "only" } as never)),
      /incomplete/i
    );
  });

  it("throws when the stored ciphertext cannot be decrypted", () => {
    // A rotated instance key must fail loudly, not resolve to empty creds.
    assert.throws(() =>
      resolveDestination({
        kind: "s3",
        config: { bucket: "b", region: "r" },
        secretEncrypted: randomBytes(64)
      })
    );
  });

  it("accepts a Uint8Array as well as a Buffer", () => {
    const buf = encryptJson(CREDS);
    const dest = resolveDestination({
      kind: "s3",
      config: { bucket: "b", region: "r" },
      secretEncrypted: new Uint8Array(buf)
    });
    assert.ok(dest.kind === "s3");
    assert.equal(dest.accessKeyId, CREDS.accessKeyId);
  });
});

describe("resolveDestination — unknown kinds", () => {
  it("throws rather than falling back to local", () => {
    for (const kind of ["gcs", "", "LOCAL", "S3"]) {
      assert.throws(
        () => resolveDestination(row(kind, { path: "/tmp" })),
        /Unsupported destination kind/,
        `expected ${JSON.stringify(kind)} to be rejected`
      );
    }
  });
});

describe("describeDestination", () => {
  it("describes a local target", () => {
    assert.equal(
      describeDestination({ kind: "local", path: "/var/backups" }),
      "local:/var/backups"
    );
  });

  it("normalizes an S3 prefix", () => {
    const base = {
      kind: "s3" as const,
      bucket: "b",
      region: "r",
      accessKeyId: CREDS.accessKeyId,
      secretAccessKey: CREDS.secretAccessKey,
      forcePathStyle: false
    };
    assert.equal(describeDestination({ ...base, prefix: "nested/dir" }), "s3:b/nested/dir/");
    assert.equal(describeDestination({ ...base, prefix: "/lead/" }), "s3:b/lead/");
    assert.equal(describeDestination({ ...base, prefix: "" }), "s3:b/");
    assert.equal(describeDestination({ ...base, prefix: undefined }), "s3:b/");
  });

  it("never includes credentials", () => {
    const text = describeDestination({
      kind: "s3",
      bucket: "b",
      region: "r",
      prefix: "p",
      accessKeyId: CREDS.accessKeyId,
      secretAccessKey: CREDS.secretAccessKey,
      forcePathStyle: false
    });
    assert.ok(!text.includes(CREDS.accessKeyId));
    assert.ok(!text.includes(CREDS.secretAccessKey));
  });
});

describe("makeBundleFilename", () => {
  const iso = "2026-08-11T09:30:00.000Z";

  it("carries a slugified org name and a filesystem-safe stamp", () => {
    const name = makeBundleFilename("Acme Corp", iso);
    assert.match(name, /^sohwe-backup-acme-corp-/);
    assert.ok(name.endsWith(BUNDLE_FILE_SUFFIX));
    // Colons are illegal on Windows and awkward as an S3 key.
    assert.ok(!name.includes(":"));
  });

  it("produces a name safe to use as a path segment or S3 key", () => {
    for (const org of ["Acme / Corp", "../../etc", "  spaced  ", "!!!", "Ünïcodé"]) {
      const name = makeBundleFilename(org, iso);
      assert.ok(!name.includes("/"), `${org} produced ${name}`);
      assert.ok(!name.includes(".."), `${org} produced ${name}`);
      assert.match(name, /^sohwe-backup-[a-z0-9-]+-\d/);
    }
  });

  it("falls back to a placeholder when the name slugifies to nothing", () => {
    assert.match(makeBundleFilename("!!!", iso), /^sohwe-backup-org-/);
  });

  it("is stable for the same inputs and distinct across timestamps", () => {
    assert.equal(makeBundleFilename("Acme", iso), makeBundleFilename("Acme", iso));
    assert.notEqual(
      makeBundleFilename("Acme", iso),
      makeBundleFilename("Acme", "2026-08-11T09:30:01.000Z")
    );
  });
});
