import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadApiConfig } from "./env";

/**
 * Boot-time validation is the instance's only guard against a configuration
 * that looks fine until something fails deep inside a request handler or a
 * deploy, so each rejection rule is pinned here.
 */

const VALID_KEY = randomBytes(32).toString("base64");

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://sohwe:pw@localhost:5432/sohwe",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "a".repeat(32),
  SOHWE_ENCRYPTION_KEY: VALID_KEY
};

/** Every variable `loadApiConfig` reads, so tests never inherit a stray value. */
const MANAGED = [
  ...Object.keys(BASE_ENV),
  "PORT",
  "NODE_ENV",
  "SOHWE_PUBLIC_URL",
  "SOHWE_CORS_ORIGIN",
  "SOHWE_HTTPS_ENABLED",
  "SOHWE_BASE_DOMAIN",
  "SOHWE_SETUP_PASSWORD"
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((k) => [k, process.env[k]]));
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, BASE_ENV);
});

afterEach(() => {
  for (const k of MANAGED) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function assertRejects(match: RegExp): void {
  assert.throws(loadApiConfig, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, match);
    return true;
  });
}

describe("loadApiConfig", () => {
  it("accepts a minimal valid environment", () => {
    const config = loadApiConfig();
    assert.equal(config.port, 3001);
    assert.equal(config.sessionSecret, BASE_ENV.SESSION_SECRET);
    assert.equal(config.baseDomain, "sohwe.localhost");
    assert.equal(config.publicUrl, null);
    assert.equal(config.setupPassword, null);
    assert.equal(config.httpsEnabled, false);
  });

  it("requires DATABASE_URL and REDIS_URL", () => {
    delete process.env.DATABASE_URL;
    assertRejects(/DATABASE_URL is required/);
    Object.assign(process.env, BASE_ENV);
    delete process.env.REDIS_URL;
    assertRejects(/REDIS_URL is required/);
  });

  it("treats a whitespace-only value as unset", () => {
    process.env.DATABASE_URL = "   ";
    assertRejects(/DATABASE_URL is required/);
  });

  it("rejects a short SESSION_SECRET", () => {
    process.env.SESSION_SECRET = "tooshort";
    assertRejects(/SESSION_SECRET must be at least 16 characters/);
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    process.env.SOHWE_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    assert.throws(loadApiConfig);
  });

  it("reports every problem at once", () => {
    delete process.env.DATABASE_URL;
    process.env.SESSION_SECRET = "x";
    process.env.PORT = "not-a-port";
    assert.throws(loadApiConfig, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /DATABASE_URL/);
      assert.match(err.message, /SESSION_SECRET/);
      assert.match(err.message, /PORT/);
      return true;
    });
  });

  it("rejects out-of-range ports", () => {
    for (const bad of ["0", "-1", "70000", "3001.5", ""]) {
      process.env.PORT = bad;
      assertRejects(/PORT must be a valid TCP port/);
    }
  });

  it("accepts a custom port", () => {
    process.env.PORT = "8080";
    assert.equal(loadApiConfig().port, 8080);
  });

  describe("SOHWE_PUBLIC_URL", () => {
    it("strips a trailing slash", () => {
      process.env.SOHWE_PUBLIC_URL = "https://deploy.example.com/";
      assert.equal(loadApiConfig().publicUrl, "https://deploy.example.com");
    });

    it("keeps a sub-path", () => {
      process.env.SOHWE_PUBLIC_URL = "https://example.com/sohwe/";
      assert.equal(loadApiConfig().publicUrl, "https://example.com/sohwe");
    });

    it("is null when blank", () => {
      process.env.SOHWE_PUBLIC_URL = "   ";
      assert.equal(loadApiConfig().publicUrl, null);
    });

    it("rejects a non-URL", () => {
      process.env.SOHWE_PUBLIC_URL = "deploy.example.com";
      assertRejects(/SOHWE_PUBLIC_URL must be an absolute URL/);
    });

    it("rejects a non-http protocol", () => {
      process.env.SOHWE_PUBLIC_URL = "ftp://deploy.example.com";
      assertRejects(/must use http or https/);
    });
  });

  describe("CORS origin", () => {
    it("defaults to the Vite dev server outside production", () => {
      assert.equal(loadApiConfig().corsOrigin, "http://localhost:3000");
    });

    it("defaults to disabled in production", () => {
      process.env.NODE_ENV = "production";
      assert.equal(loadApiConfig().corsOrigin, false);
    });

    it("accepts a single origin", () => {
      process.env.SOHWE_CORS_ORIGIN = "https://app.example.com";
      assert.equal(loadApiConfig().corsOrigin, "https://app.example.com");
    });

    it("accepts a comma-separated list", () => {
      process.env.SOHWE_CORS_ORIGIN = "https://a.test, https://b.test";
      assert.deepEqual(loadApiConfig().corsOrigin, [
        "https://a.test",
        "https://b.test"
      ]);
    });

    it("treats * as allow-all", () => {
      process.env.SOHWE_CORS_ORIGIN = "*";
      assert.equal(loadApiConfig().corsOrigin, true);
    });
  });

  it("reads the optional settings", () => {
    process.env.SOHWE_HTTPS_ENABLED = "true";
    process.env.SOHWE_BASE_DOMAIN = "apps.example.com";
    process.env.SOHWE_SETUP_PASSWORD = "hunter2";
    const config = loadApiConfig();
    assert.equal(config.httpsEnabled, true);
    assert.equal(config.baseDomain, "apps.example.com");
    assert.equal(config.setupPassword, "hunter2");
  });

  it("only enables HTTPS for the exact string \"true\"", () => {
    for (const v of ["TRUE", "1", "yes", ""]) {
      process.env.SOHWE_HTTPS_ENABLED = v;
      assert.equal(loadApiConfig().httpsEnabled, false, `for ${JSON.stringify(v)}`);
    }
  });
});
