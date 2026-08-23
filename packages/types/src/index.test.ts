import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AcceptInvitationSchema,
  appDockerVolumeName,
  appInternalNetworkName,
  AuditLogQuerySchema,
  buildDatastoreConnectionUrl,
  CreateApplicationSchema,
  CreateDatastoreBindingSchema,
  CreateDomainSchema,
  CreateDatastoreSchema,
  datastoreContainerName,
  datastoreDefaultEnvKey,
  datastoreServicePort,
  datastoreVolumeName,
  CreateInvitationSchema,
  EnvKeySchema,
  EnvQuerySchema,
  EnvVarsPatchSchema,
  EnvVarsReplaceSchema,
  FsPathQuerySchema,
  RoleSchema,
  RollbackBodySchema,
  UpdateApplicationSchema,
  UpdateMemberRoleSchema,
  VolumeCreateSchema
} from "./index";

/**
 * These schemas are the API's outer boundary — every request body from the
 * dashboard is parsed by one of them — and the Docker naming helpers decide
 * which container's volume or network a deploy touches. Both are load-bearing
 * enough to pin.
 */

describe("CreateApplicationSchema", () => {
  const valid = {
    name: "Web",
    slug: "web",
    gitRepo: "https://github.com/acme/web"
  };

  it("applies the documented defaults", () => {
    const out = CreateApplicationSchema.parse(valid);
    assert.equal(out.gitBranch, "main");
    assert.equal(out.port, 3000);
    assert.equal(out.buildMode, "auto");
    assert.equal(out.autoDeploy, false);
    assert.equal(out.domain, undefined);
  });

  it("coerces a numeric string port", () => {
    // Query/form values arrive as strings; the route must not 400 on "8080".
    assert.equal(CreateApplicationSchema.parse({ ...valid, port: "8080" }).port, 8080);
  });

  it("rejects ports outside the TCP range", () => {
    for (const port of [0, -1, 65536, 1.5]) {
      assert.throws(() => CreateApplicationSchema.parse({ ...valid, port }));
    }
  });

  it("requires a slug safe for Docker and Traefik names", () => {
    for (const slug of ["Web", "my_app", "my app", "app!", "", "app/../x"]) {
      assert.throws(
        () => CreateApplicationSchema.parse({ ...valid, slug }),
        `expected ${JSON.stringify(slug)} to be rejected`
      );
    }
    assert.doesNotThrow(() => CreateApplicationSchema.parse({ ...valid, slug: "my-app-2" }));
  });

  it("requires a URL for the repository", () => {
    assert.throws(() => CreateApplicationSchema.parse({ ...valid, gitRepo: "acme/web" }));
  });

  it("rejects an unknown build mode", () => {
    assert.throws(() => CreateApplicationSchema.parse({ ...valid, buildMode: "bazel" }));
  });

  describe("domain", () => {
    it("accepts a normal hostname", () => {
      assert.equal(
        CreateApplicationSchema.parse({ ...valid, domain: "app.example.com" }).domain,
        "app.example.com"
      );
    });

    it("treats an empty string as absent", () => {
      // The dashboard sends "" for a cleared input; that must not 400.
      assert.equal(CreateApplicationSchema.parse({ ...valid, domain: "" }).domain, undefined);
    });

    it("rejects malformed domains", () => {
      for (const domain of [
        "App.Example.com",
        "example",
        "-bad.example.com",
        "example..com",
        "http://app.example.com",
        "app.example.com/path",
        "app.example.com:8080"
      ]) {
        assert.throws(
          () => CreateApplicationSchema.parse({ ...valid, domain }),
          `expected ${JSON.stringify(domain)} to be rejected`
        );
      }
    });
  });
});

describe("UpdateApplicationSchema", () => {
  it("accepts an empty patch", () => {
    assert.deepEqual(UpdateApplicationSchema.parse({}), {});
  });

  it("allows clearing nullable fields", () => {
    const out = UpdateApplicationSchema.parse({
      buildCmd: null,
      startCmd: null,
      memoryLimitMb: null,
      cpuLimit: null
    });
    assert.equal(out.buildCmd, null);
    assert.equal(out.memoryLimitMb, null);
  });

  it("ignores a domain patch — domains have their own routes now", () => {
    const out = UpdateApplicationSchema.parse({ domain: "app.example.com" });
    assert.deepEqual(out, {});
  });

  it("bounds the resource limits", () => {
    assert.throws(() => UpdateApplicationSchema.parse({ memoryLimitMb: 8 }));
    assert.throws(() => UpdateApplicationSchema.parse({ memoryLimitMb: 65_537 }));
    assert.throws(() => UpdateApplicationSchema.parse({ cpuLimit: 0 }));
    assert.throws(() => UpdateApplicationSchema.parse({ cpuLimit: 65 }));
    assert.equal(UpdateApplicationSchema.parse({ memoryLimitMb: "512" }).memoryLimitMb, 512);
    assert.equal(UpdateApplicationSchema.parse({ cpuLimit: "1.5" }).cpuLimit, 1.5);
  });

  it("rejects an empty branch name", () => {
    assert.throws(() => UpdateApplicationSchema.parse({ gitBranch: "" }));
  });
});

describe("EnvKeySchema", () => {
  it("accepts POSIX-shaped names", () => {
    for (const key of ["NODE_ENV", "_PRIVATE", "API_KEY_2", "a"]) {
      assert.equal(EnvKeySchema.parse(key), key);
    }
  });

  it("rejects names a shell could not export", () => {
    for (const key of ["2FA", "MY-KEY", "MY KEY", "", "KEY=VALUE", "KEY\nOTHER"]) {
      assert.throws(
        () => EnvKeySchema.parse(key),
        `expected ${JSON.stringify(key)} to be rejected`
      );
    }
  });

  it("bounds the key length", () => {
    assert.doesNotThrow(() => EnvKeySchema.parse("A".repeat(128)));
    assert.throws(() => EnvKeySchema.parse("A".repeat(129)));
  });
});

describe("env var payloads", () => {
  it("accepts a full replacement", () => {
    const out = EnvVarsReplaceSchema.parse({ vars: { NODE_ENV: "production" } });
    assert.deepEqual(out.vars, { NODE_ENV: "production" });
  });

  it("accepts an empty replacement, which clears everything", () => {
    assert.deepEqual(EnvVarsReplaceSchema.parse({ vars: {} }).vars, {});
  });

  it("rejects an oversized value", () => {
    assert.throws(() =>
      EnvVarsReplaceSchema.parse({ vars: { BIG: "x".repeat(32_769) } })
    );
  });

  it("rejects an invalid key in a patch", () => {
    assert.throws(() => EnvVarsPatchSchema.parse({ set: { "BAD-KEY": "v" } }));
    assert.throws(() => EnvVarsPatchSchema.parse({ unset: ["BAD-KEY"] }));
  });

  it("allows set and unset independently", () => {
    assert.deepEqual(EnvVarsPatchSchema.parse({ set: { A: "1" } }).unset, undefined);
    assert.deepEqual(EnvVarsPatchSchema.parse({ unset: ["A"] }).set, undefined);
  });
});

describe("EnvQuerySchema", () => {
  it("only reveals for an explicit true or 1", () => {
    assert.equal(EnvQuerySchema.parse({ reveal: "true" }).reveal, true);
    assert.equal(EnvQuerySchema.parse({ reveal: "1" }).reveal, true);
  });

  it("defaults to masked", () => {
    // Anything else must stay masked — this decides whether secrets are sent.
    for (const reveal of [undefined, "", "false", "0", "yes", "TRUE"]) {
      assert.equal(EnvQuerySchema.parse({ reveal }).reveal, false, `for ${String(reveal)}`);
    }
  });
});

describe("FsPathQuerySchema", () => {
  it("defaults to the container root", () => {
    assert.equal(FsPathQuerySchema.parse({}).path, "/");
    assert.equal(FsPathQuerySchema.parse({ path: "" }).path, "/");
  });

  it("passes a path through untouched", () => {
    // Traversal rejection is normalizeContainerPath's job, not the schema's.
    assert.equal(FsPathQuerySchema.parse({ path: "/app" }).path, "/app");
  });
});

describe("VolumeCreateSchema", () => {
  it("accepts an absolute mount path", () => {
    assert.equal(VolumeCreateSchema.parse({ mountPath: "/app/data" }).mountPath, "/app/data");
  });

  it("rejects the container root", () => {
    assert.throws(() => VolumeCreateSchema.parse({ mountPath: "/" }));
  });

  it("rejects relative paths and traversal", () => {
    for (const mountPath of ["data", "./data", "/app/../etc", "/..", "/app/..", ""]) {
      assert.throws(
        () => VolumeCreateSchema.parse({ mountPath }),
        `expected ${JSON.stringify(mountPath)} to be rejected`
      );
    }
  });

  it("rejects shell metacharacters in the path", () => {
    for (const mountPath of ["/app/$(id)", "/app/a b", "/app/a;b", "/app/a|b"]) {
      assert.throws(
        () => VolumeCreateSchema.parse({ mountPath }),
        `expected ${JSON.stringify(mountPath)} to be rejected`
      );
    }
  });

  it("requires a positive size hint when given", () => {
    assert.equal(VolumeCreateSchema.parse({ mountPath: "/d", sizeBytes: "1024" }).sizeBytes, 1024);
    assert.throws(() => VolumeCreateSchema.parse({ mountPath: "/d", sizeBytes: 0 }));
    assert.throws(() => VolumeCreateSchema.parse({ mountPath: "/d", sizeBytes: -1 }));
  });
});

describe("RollbackBodySchema", () => {
  it("requires a uuid", () => {
    const id = "6c84fb90-12c4-11e1-840d-7b25c5ee775a";
    assert.equal(RollbackBodySchema.parse({ sourceDeploymentId: id }).sourceDeploymentId, id);
    assert.throws(() => RollbackBodySchema.parse({ sourceDeploymentId: "not-a-uuid" }));
  });
});

describe("Docker naming helpers", () => {
  const appId = "11111111-2222-3333-4444-555555555555";
  const volumeId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("matches the documented volume name", () => {
    assert.equal(
      appDockerVolumeName(appId, volumeId),
      `sohwe_app_${appId}_${volumeId}`
    );
  });

  it("matches the documented network name", () => {
    assert.equal(appInternalNetworkName(appId), `sohwe_app_${appId}_net`);
  });

  it("produces names Docker accepts", () => {
    // Docker requires [a-zA-Z0-9][a-zA-Z0-9_.-]*.
    const pattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
    assert.match(appDockerVolumeName(appId, volumeId), pattern);
    assert.match(appInternalNetworkName(appId), pattern);
  });

  it("keeps volumes of different apps distinct", () => {
    const other = "99999999-2222-3333-4444-555555555555";
    assert.notEqual(
      appDockerVolumeName(appId, volumeId),
      appDockerVolumeName(other, volumeId)
    );
    assert.notEqual(appInternalNetworkName(appId), appInternalNetworkName(other));
  });

  it("shares a prefix with the network name without that being a conflict", () => {
    // The two schemes do overlap in principle — a volume id of "net" produces
    // exactly the network name — but they name different Docker object types,
    // which are separate namespaces, and a volume id is always a uuid.
    assert.equal(appDockerVolumeName(appId, "net"), appInternalNetworkName(appId));
    assert.ok(appDockerVolumeName(appId, volumeId).startsWith(`sohwe_app_${appId}_`));
    assert.ok(appInternalNetworkName(appId).startsWith(`sohwe_app_${appId}_`));
  });

  it("keeps every managed name under the sohwe_app_ prefix", () => {
    // Cleanup on app delete finds resources by this prefix and by label.
    assert.ok(appDockerVolumeName(appId, volumeId).startsWith("sohwe_app_"));
    assert.ok(appInternalNetworkName(appId).startsWith("sohwe_app_"));
  });
});

describe("RoleSchema", () => {
  it("accepts exactly the three org roles", () => {
    for (const role of ["owner", "admin", "member"]) {
      assert.equal(RoleSchema.parse(role), role);
    }
  });

  it("rejects anything else, including case variants", () => {
    for (const bad of ["Owner", "superuser", "", "OWNER"]) {
      assert.equal(RoleSchema.safeParse(bad).success, false, bad);
    }
  });

  it("is the same vocabulary a role change may target", () => {
    assert.ok(UpdateMemberRoleSchema.safeParse({ role: "owner" }).success);
    assert.equal(UpdateMemberRoleSchema.safeParse({ role: "nobody" }).success, false);
  });
});

describe("CreateInvitationSchema", () => {
  it("normalizes the email so one address cannot be invited twice", () => {
    // The duplicate checks on both the invitation and the user table compare
    // exact strings, so casing and stray whitespace have to be gone by then.
    const parsed = CreateInvitationSchema.parse({ email: "  New.Person@Example.TEST " });
    assert.equal(parsed.email, "new.person@example.test");
  });

  it("defaults to the least privileged role", () => {
    assert.equal(CreateInvitationSchema.parse({ email: "a@b.test" }).role, "member");
  });

  it("refuses to grant owner by invitation", () => {
    // Owner is only ever conferred by an existing owner, never by a link.
    assert.equal(
      CreateInvitationSchema.safeParse({ email: "a@b.test", role: "owner" }).success,
      false
    );
  });

  it("rejects a malformed address", () => {
    assert.equal(CreateInvitationSchema.safeParse({ email: "not-an-email" }).success, false);
  });
});

describe("AcceptInvitationSchema", () => {
  const valid = {
    token: "x".repeat(43),
    name: "New Person",
    password: "correct horse battery"
  };

  it("accepts a well-formed redemption", () => {
    assert.equal(AcceptInvitationSchema.parse(valid).name, "New Person");
  });

  it("enforces a minimum password length", () => {
    assert.equal(
      AcceptInvitationSchema.safeParse({ ...valid, password: "short" }).success,
      false
    );
  });

  it("rejects a token too short to be one of ours", () => {
    assert.equal(AcceptInvitationSchema.safeParse({ ...valid, token: "abc" }).success, false);
  });

  it("requires a name", () => {
    assert.equal(AcceptInvitationSchema.safeParse({ ...valid, name: "" }).success, false);
  });
});

describe("AuditLogQuerySchema", () => {
  it("defaults to a bounded page", () => {
    assert.equal(AuditLogQuerySchema.parse({}).limit, 50);
  });

  it("coerces a string limit from the query string", () => {
    assert.equal(AuditLogQuerySchema.parse({ limit: "10" }).limit, 10);
  });

  it("refuses an unbounded page size", () => {
    assert.equal(AuditLogQuerySchema.safeParse({ limit: "100000" }).success, false);
    assert.equal(AuditLogQuerySchema.safeParse({ limit: "0" }).success, false);
  });

  it("requires the cursor to be an id, not arbitrary text", () => {
    assert.equal(AuditLogQuerySchema.safeParse({ cursor: "not-a-uuid" }).success, false);
  });
});

describe("datastore naming helpers", () => {
  it("derives the data volume name from the datastore id", () => {
    assert.equal(datastoreVolumeName("abc-123"), "sohwe_datastore_abc-123_data");
  });

  it("derives the container (DNS) name from the slug", () => {
    assert.equal(datastoreContainerName("main-db"), "sohwe-ds-main-db");
  });

  it("sanitizes and caps the container name at Docker's 63-char limit", () => {
    assert.equal(datastoreContainerName("has_underscore"), "sohwe-ds-has-underscore");
    const long = datastoreContainerName("x".repeat(100));
    assert.equal(long.length, 63);
  });

  it("maps kinds to their service ports and default env keys", () => {
    assert.equal(datastoreServicePort("postgres"), 5432);
    assert.equal(datastoreServicePort("redis"), 6379);
    assert.equal(datastoreDefaultEnvKey("postgres"), "DATABASE_URL");
    assert.equal(datastoreDefaultEnvKey("redis"), "REDIS_URL");
  });
});

describe("buildDatastoreConnectionUrl", () => {
  it("builds a postgres URL with user, password, host, port, and database", () => {
    assert.equal(
      buildDatastoreConnectionUrl(
        "postgres",
        { username: "sohwe", password: "p_w-1", database: "main_db" },
        "sohwe-ds-main-db",
        5432
      ),
      "postgresql://sohwe:p_w-1@sohwe-ds-main-db:5432/main_db"
    );
  });

  it("builds a redis URL with only the password", () => {
    assert.equal(
      buildDatastoreConnectionUrl("redis", { password: "p" }, "sohwe-ds-cache", 6379),
      "redis://:p@sohwe-ds-cache:6379/0"
    );
  });
});

describe("CreateDatastoreSchema", () => {
  const valid = { kind: "postgres", name: "Main DB", slug: "main-db" };

  it("accepts a minimal create and leaves engineVersion to the server", () => {
    const parsed = CreateDatastoreSchema.parse(valid);
    assert.equal(parsed.kind, "postgres");
    assert.equal(parsed.engineVersion, undefined);
  });

  it("rejects an unknown kind", () => {
    assert.equal(
      CreateDatastoreSchema.safeParse({ ...valid, kind: "mysql" }).success,
      false
    );
  });

  it("rejects an invalid slug", () => {
    assert.equal(
      CreateDatastoreSchema.safeParse({ ...valid, slug: "Has Spaces" }).success,
      false
    );
  });

  it("bounds the resource limits", () => {
    assert.equal(
      CreateDatastoreSchema.safeParse({ ...valid, memoryLimitMb: 4 }).success,
      false
    );
    assert.equal(
      CreateDatastoreSchema.safeParse({ ...valid, cpuLimit: 100 }).success,
      false
    );
  });
});

describe("CreateDatastoreBindingSchema", () => {
  const appId = "6b1f8f0a-2c3d-4e5f-8a9b-0c1d2e3f4a5b";

  it("accepts an app id with the env key defaulted", () => {
    const parsed = CreateDatastoreBindingSchema.parse({ applicationId: appId });
    assert.equal(parsed.envKey, undefined);
  });

  it("rejects a malformed env key", () => {
    assert.equal(
      CreateDatastoreBindingSchema.safeParse({
        applicationId: appId,
        envKey: "1BAD-KEY"
      }).success,
      false
    );
  });
});

describe("CreateDomainSchema", () => {
  it("accepts a plain hostname and defaults to non-primary", () => {
    const parsed = CreateDomainSchema.parse({ hostname: "app.example.com" });
    assert.equal(parsed.hostname, "app.example.com");
    assert.equal(parsed.primary, false);
  });

  it("normalizes what people actually paste", () => {
    // Each of these is a real thing to copy out of a browser or a registrar.
    const cases: [string, string][] = [
      ["  App.Example.COM  ", "app.example.com"],
      ["https://app.example.com", "app.example.com"],
      ["http://app.example.com/pricing?ref=x", "app.example.com"],
      ["app.example.com.", "app.example.com"],
      ["app.example.com:8080", "app.example.com"],
      ["https://app.example.com:443/", "app.example.com"]
    ];
    for (const [input, expected] of cases) {
      assert.equal(
        CreateDomainSchema.parse({ hostname: input }).hostname,
        expected,
        `normalizing ${JSON.stringify(input)}`
      );
    }
  });

  it("still rejects what is not a hostname after normalizing", () => {
    for (const hostname of [
      "",
      "example",
      "-bad.example.com",
      "example..com",
      "https://",
      "192.168.0.1"
    ]) {
      assert.equal(
        CreateDomainSchema.safeParse({ hostname }).success,
        false,
        `expected ${JSON.stringify(hostname)} to be rejected`
      );
    }
  });
});
