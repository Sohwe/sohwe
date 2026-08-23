import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultApplicationSelect,
  deploymentListSelect,
  serializeAppListRow,
  serializeVolume,
  volumeListSelect
} from "./app-public";

/**
 * These selects are the enforcement point for "no endpoint returns encrypted
 * env vars". A field added to the Prisma model does not appear here unless
 * someone opts it in, and these tests fail loudly if a secret ever is.
 */

/** Anything that must never reach a general-purpose response. */
const SECRET_FIELDS = [
  "envVarsEncrypted",
  "credentialsEncrypted",
  "passphraseEncrypted",
  "secretEncrypted",
  "passwordHash"
];

describe("defaultApplicationSelect", () => {
  const select = defaultApplicationSelect(10);

  it("never selects a secret field", () => {
    for (const field of SECRET_FIELDS) {
      assert.ok(
        !(field in select),
        `${field} must not be in the default application select`
      );
    }
  });

  it("selects only explicitly listed fields", () => {
    // `true` for scalars, an object for relations — never a bare spread that
    // could pull in a future column.
    for (const [key, value] of Object.entries(select)) {
      assert.ok(
        value === true || (typeof value === "object" && value !== null),
        `unexpected select value for ${key}`
      );
    }
  });

  it("includes the fields the dashboard renders", () => {
    for (const field of [
      "id",
      "name",
      "slug",
      "gitRepo",
      "gitBranch",
      "repoFullName",
      "autoDeploy",
      "buildMode",
      "port",
      "status",
      "memoryLimitMb",
      "cpuLimit"
    ]) {
      assert.equal(select[field as keyof typeof select], true, `missing ${field}`);
    }
  });

  it("bounds the deployments it pulls back", () => {
    const deployments = defaultApplicationSelect(3).deployments;
    assert.ok(typeof deployments === "object" && deployments !== null);
    assert.equal((deployments as { take: number }).take, 3);
  });

  it("orders deployments newest first and volumes oldest first", () => {
    const deployments = select.deployments as { orderBy: { createdAt: string } };
    const volumes = select.volumes as { orderBy: { createdAt: string } };
    assert.equal(deployments.orderBy.createdAt, "desc");
    assert.equal(volumes.orderBy.createdAt, "asc");
  });
});

describe("deploymentListSelect", () => {
  it("excludes buildLogs", () => {
    // Build logs are capped but still large, and the list endpoint returns one
    // row per deployment per app; they are fetched over SSE instead.
    assert.ok(!("buildLogs" in deploymentListSelect));
  });

  it("includes the failure summary the UI shows", () => {
    assert.equal(deploymentListSelect.errorMessage, true);
    assert.equal(deploymentListSelect.trigger, true);
  });
});

describe("serializeVolume", () => {
  const createdAt = new Date("2026-01-02T03:04:05.000Z");

  it("renders BigInt sizes as strings", () => {
    const out = serializeVolume({
      id: "v1",
      mountPath: "/data",
      sizeBytes: 9_007_199_254_740_993n,
      createdAt
    });
    assert.equal(out.sizeBytes, "9007199254740993");
    // The point of the string: a Number round-trip would silently lose the
    // low bit, since the value is past Number.MAX_SAFE_INTEGER.
    assert.notEqual(String(Number(out.sizeBytes)), out.sizeBytes);
  });

  it("passes null through", () => {
    const out = serializeVolume({
      id: "v1",
      mountPath: "/data",
      sizeBytes: null,
      createdAt
    });
    assert.equal(out.sizeBytes, null);
  });

  it("produces a JSON-serializable object", () => {
    const out = serializeVolume({
      id: "v1",
      mountPath: "/data",
      sizeBytes: 1n,
      createdAt
    });
    assert.doesNotThrow(() => JSON.stringify(out));
  });

  it("drops fields that are not in the public shape", () => {
    const out = serializeVolume({
      id: "v1",
      mountPath: "/data",
      sizeBytes: null,
      createdAt,
      ...{ applicationId: "secret-ish" }
    } as never);
    assert.deepEqual(Object.keys(out).sort(), [
      "createdAt",
      "id",
      "mountPath",
      "sizeBytes"
    ]);
  });
});

describe("serializeAppListRow", () => {
  it("serializes every volume and leaves other fields alone", () => {
    const row = {
      id: "a1",
      name: "web",
      volumes: [
        {
          id: "v1",
          mountPath: "/data",
          sizeBytes: 1024n,
          createdAt: new Date(0)
        },
        {
          id: "v2",
          mountPath: "/cache",
          sizeBytes: null,
          createdAt: new Date(0)
        }
      ]
    };
    const out = serializeAppListRow({ ...row, domains: [] });
    // The row's non-volume fields are passed through untouched. They are typed
    // as an index signature, so they are read back the same way.
    assert.equal((out as Record<string, unknown>).id, "a1");
    assert.equal((out as Record<string, unknown>).name, "web");
    assert.deepEqual(
      out.volumes.map((v) => v.sizeBytes),
      ["1024", null]
    );
    assert.doesNotThrow(() => JSON.stringify(out));
  });

  it("handles an app with no volumes", () => {
    const out = serializeAppListRow({ id: "a1", volumes: [], domains: [] });
    assert.deepEqual(out.volumes, []);
    assert.doesNotThrow(() => JSON.stringify(out));
  });

  it("derives `domain` from the primary domain", () => {
    // Every caller of the old `Application.domain` column reads this field.
    const domain = (hostname: string, isPrimary: boolean) => ({
      id: hostname,
      applicationId: "a1",
      hostname,
      isPrimary,
      lastStatus: null,
      lastCheckedAt: null,
      verifiedAt: null,
      createdAt: new Date(0)
    });
    const out = serializeAppListRow({
      id: "a1",
      volumes: [],
      domains: [domain("acme.com", false), domain("www.acme.com", true)]
    });
    assert.equal(out.domain, "www.acme.com");
  });

  it("reports no domain when none is primary", () => {
    assert.equal(serializeAppListRow({ id: "a1", volumes: [], domains: [] }).domain, null);
  });
});

describe("volumeListSelect", () => {
  it("does not expose the owning application id", () => {
    assert.ok(!("applicationId" in volumeListSelect));
  });
});
