import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildBundle, canonicalize } from "@sohwe/bundler";
import {
  decryptJson,
  deriveBundleKey,
  encryptJson,
  hmacSign,
  randomBundleSalt,
  SCRYPT_PARAMS
} from "@sohwe/crypto";

/**
 * HTTP-level tests for the API, driven through `app.inject()` so no port is
 * bound. These exercise the parts that only exist once a request, a session,
 * and a database row meet: authentication, organization scoping, the setup
 * gate, and the promise that secrets never appear in a response.
 *
 * They need a **throwaway** Postgres, opted into explicitly with
 * `TEST_DATABASE_URL`. Without it the suite skips rather than falling back to
 * `DATABASE_URL`, because every test truncates every table and doing that to
 * someone's development database would be unforgivable.
 *
 *   docker run -d --name sohwe-test-db -e POSTGRES_DB=sohwe_test \
 *     -e POSTGRES_USER=sohwe -e POSTGRES_PASSWORD=password -p 55440:5432 \
 *     postgres:16-alpine
 *   cd packages/db && DATABASE_URL=<url> pnpm exec prisma migrate deploy
 *   TEST_DATABASE_URL=<url> pnpm --filter @sohwe/api test
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set (see the comment at the top of this file)";

// Must be set before `@sohwe/db` is imported: the Prisma client reads the
// datasource URL when it is constructed, at module load.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.SOHWE_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";

const OWNER = {
  email: "owner@example.test",
  password: "correct horse battery staple",
  name: "Owner",
  organizationName: "Acme"
};

let prisma: typeof import("@sohwe/db").prisma;
let buildServer: typeof import("./server").buildServer;
let loadApiConfig: typeof import("./env").loadApiConfig;

/** Tables truncated between tests, children before parents. */
const TABLES = [
  "dns_provider_credentials",
  "datastore_bindings",
  "datastores",
  "audit_logs",
  "invitations",
  "webhook_deliveries",
  "bundles",
  "backup_schedules",
  "backup_destinations",
  "github_installations",
  "github_apps",
  "alert_destinations",
  "volumes",
  "deployments",
  "applications",
  "sessions",
  "users",
  "organizations"
];

describe("API routes", { skip }, () => {
  let app: FastifyInstance;

  before(async () => {
    ({ prisma } = await import("@sohwe/db"));
    ({ buildServer } = await import("./server"));
    ({ loadApiConfig } = await import("./env"));
  });

  after(async () => {
    // Closing the server also closes the deploy queue and stats Redis client
    // that the route modules open at import; without that the process hangs.
    if (app) await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`
    );
    delete process.env.SOHWE_SETUP_PASSWORD;
    delete process.env.SOHWE_HOST_FS_ALLOWLIST;
    // A fresh instance per test also resets the in-memory rate-limit counters,
    // so one test spending the login budget cannot fail the next.
    if (app) await app.close();
    app = await buildServer(loadApiConfig(), { logger: false });
  });

  /** Complete first-run setup and return the session cookie for the owner. */
  async function signIn(): Promise<string> {
    await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: OWNER.email, password: OWNER.password }
    });
    assert.equal(res.statusCode, 200, res.body);
    const cookie = res.cookies.find((c) => c.name === "sohwe_session");
    assert.ok(cookie, "expected a session cookie");
    return `sohwe_session=${cookie.value}`;
  }

  async function createApp(
    cookie: string,
    overrides: Record<string, unknown> = {}
  ): Promise<{ id: string; slug: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/applications",
      headers: { cookie },
      payload: {
        name: "Web",
        slug: "web",
        gitRepo: "https://github.com/acme/web",
        ...overrides
      }
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { id: string; slug: string };
  }

  /**
   * Add a second user to the owner's organization at `role` and return their
   * session cookie. Written straight to the database because there is no API
   * for creating a user with a chosen role other than the invitation flow,
   * which most of these tests are not exercising.
   */
  async function signInAs(role: string, email = `${role}@example.test`): Promise<string> {
    const owner = await prisma.user.findUniqueOrThrow({
      where: { email: OWNER.email },
      select: { organizationId: true, passwordHash: true }
    });
    const user = await prisma.user.create({
      data: {
        email,
        name: role,
        // Same hash as the owner, so OWNER.password signs this account in too.
        passwordHash: owner.passwordHash,
        role,
        organizationId: owner.organizationId
      }
    });
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      }
    });
    return `sohwe_session=${session.id}`;
  }

  describe("health and config", () => {
    it("reports health without authentication", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().status, "ok");
    });

    it("serves the apps base domain publicly", async () => {
      // The dashboard fetches this before login, on every render.
      const res = await app.inject({ method: "GET", url: "/api/config" });
      assert.equal(res.statusCode, 200);
      assert.equal(typeof res.json().baseDomain, "string");
      assert.equal(typeof res.json().version, "string");
    });
  });

  describe("first-run setup", () => {
    it("reports that setup is needed on an empty instance", async () => {
      const res = await app.inject({ method: "GET", url: "/api/setup/status" });
      assert.deepEqual(res.json(), {
        needsSetup: true,
        setupGateActive: false,
        setupUnlocked: false
      });
    });

    it("creates the owner and organization", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: OWNER
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().ok, true);

      const user = await prisma.user.findUnique({ where: { email: OWNER.email } });
      assert.ok(user);
      assert.equal(user.role, "owner");
      // The password must be hashed, never stored as given.
      assert.notEqual(user.passwordHash, OWNER.password);
      assert.match(user.passwordHash, /^\$argon2/);
    });

    it("refuses a second setup", async () => {
      await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
      const res = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { ...OWNER, email: "second@example.test" }
      });
      assert.equal(res.statusCode, 409);
      assert.equal(await prisma.user.count(), 1);
    });

    it("reports setup complete afterwards", async () => {
      await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
      const res = await app.inject({ method: "GET", url: "/api/setup/status" });
      assert.equal(res.json().needsSetup, false);
    });
  });

  describe("authentication", () => {
    it("rejects a wrong password without revealing whether the user exists", async () => {
      await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
      const wrongPassword = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: OWNER.email, password: "wrong-password-entirely" }
      });
      const noSuchUser = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "nobody@example.test", password: "wrong-password-entirely" }
      });
      assert.equal(wrongPassword.statusCode, 401);
      assert.equal(noSuchUser.statusCode, 401);
      assert.equal(wrongPassword.json().message, noSuchUser.json().message);
    });

    it("issues an httpOnly session cookie on success", async () => {
      await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: OWNER.email, password: OWNER.password }
      });
      const cookie = res.cookies.find((c) => c.name === "sohwe_session");
      assert.ok(cookie);
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.sameSite, "Lax");
      assert.equal(cookie.path, "/");
    });

    it("never returns the password hash", async () => {
      await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: OWNER.email, password: OWNER.password }
      });
      assert.ok(!res.body.includes("argon2"));
      assert.ok(!("passwordHash" in (res.json() as object)));
    });

    it("resolves the current user from the session", async () => {
      const cookie = await signIn();
      const res = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
      assert.equal(res.statusCode, 200);
      const me = res.json();
      assert.equal(me.email, OWNER.email);
      assert.equal(me.organization.name, OWNER.organizationName);
    });

    it("rejects /api/me without a session", async () => {
      await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
      const res = await app.inject({ method: "GET", url: "/api/me" });
      assert.equal(res.statusCode, 401);
    });

    it("rejects an unknown session id", async () => {
      await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
      const res = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: "sohwe_session=11111111-2222-3333-4444-555555555555" }
      });
      assert.equal(res.statusCode, 401);
    });

    it("rejects an expired session", async () => {
      const cookie = await signIn();
      await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
      assert.equal(res.statusCode, 401);
    });

    it("invalidates the session on logout", async () => {
      const cookie = await signIn();
      const out = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie }
      });
      assert.equal(out.statusCode, 200);
      assert.equal(await prisma.session.count(), 0);

      const after = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
      assert.equal(after.statusCode, 401);
    });

    it("rate-limits repeated login attempts", async () => {
      await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
      const attempt = () =>
        app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: OWNER.email, password: "wrong-password-entirely" }
        });

      let last = await attempt();
      for (let i = 0; i < 10 && last.statusCode !== 429; i++) last = await attempt();
      assert.equal(last.statusCode, 429, "expected a 429 within 11 attempts");
      assert.ok(last.headers["retry-after"], "expected a Retry-After header");
    });
  });

  describe("applications", () => {
    it("requires authentication for every application route", async () => {
      await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
      const id = "11111111-2222-3333-4444-555555555555";
      // Payloads are valid on purpose: body validation runs before the auth
      // preHandler, so an invalid body would be rejected as a 400 and prove
      // nothing about whether the route is protected.
      for (const [method, url, payload] of [
        ["GET", "/api/applications", undefined],
        [
          "POST",
          "/api/applications",
          { name: "Web", slug: "web", gitRepo: "https://github.com/acme/web" }
        ],
        ["GET", `/api/applications/${id}`, undefined],
        ["PATCH", `/api/applications/${id}`, { name: "Renamed" }],
        ["DELETE", `/api/applications/${id}`, undefined],
        ["POST", `/api/applications/${id}/deploy`, {}],
        ["GET", `/api/applications/${id}/env`, undefined],
        ["PUT", `/api/applications/${id}/env`, { vars: { A: "1" } }],
        ["GET", `/api/applications/${id}/build-args`, undefined],
        ["PUT", `/api/applications/${id}/build-args`, { vars: { A: "1" } }],
        ["GET", `/api/applications/${id}/variables`, undefined],
        ["PUT", `/api/applications/${id}/variables`, { vars: [] }],
        ["GET", `/api/applications/${id}/stats`, undefined],
        ["GET", `/api/applications/${id}/volumes`, undefined]
      ] as const) {
        const res = await app.inject({ method, url, payload });
        assert.equal(res.statusCode, 401, `${method} ${url} was not protected`);
      }
      // Nothing was created by the unauthenticated POST.
      assert.equal(await prisma.application.count(), 0);
    });

    it("creates and lists an application", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      assert.ok(created.id);

      const list = await app.inject({
        method: "GET",
        url: "/api/applications",
        headers: { cookie }
      });
      assert.equal(list.statusCode, 200);
      const rows = list.json() as { id: string }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.id, created.id);
    });

    it("derives repoFullName from a GitHub remote", async () => {
      // The push webhook matches on this column, so it has to be populated.
      const cookie = await signIn();
      const created = await createApp(cookie);
      const row = await prisma.application.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(row.repoFullName, "acme/web");
    });

    it("leaves repoFullName null for a non-GitHub remote", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie, {
        slug: "gitlab-app",
        gitRepo: "https://gitlab.com/acme/web"
      });
      const row = await prisma.application.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(row.repoFullName, null);
    });

    it("rejects a duplicate slug within the organization", async () => {
      const cookie = await signIn();
      await createApp(cookie);
      const res = await app.inject({
        method: "POST",
        url: "/api/applications",
        headers: { cookie },
        payload: {
          name: "Web Again",
          slug: "web",
          gitRepo: "https://github.com/acme/web2"
        }
      });
      assert.equal(res.statusCode, 409, res.body);
      const message = (res.json() as { message: string }).message;
      assert.match(message, /already exists/i);
      assert.match(message, /web/);
      // The dashboard renders this verbatim, so it must not be Prisma's own
      // text about constraints and columns.
      assert.doesNotMatch(message, /prisma|constraint|organization_id/i);
      assert.equal(await prisma.application.count(), 1);
    });

    it("rejects a malformed body", async () => {
      const cookie = await signIn();
      const res = await app.inject({
        method: "POST",
        url: "/api/applications",
        headers: { cookie },
        payload: { name: "Web", slug: "Not A Slug", gitRepo: "not-a-url" }
      });
      assert.equal(res.statusCode, 400);
    });

    it("never returns encrypted env vars", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      await app.inject({
        method: "PUT",
        url: `/api/applications/${created.id}/env`,
        headers: { cookie },
        payload: { vars: { SECRET_TOKEN: "super-secret-value" } }
      });

      for (const url of ["/api/applications", `/api/applications/${created.id}`]) {
        const res = await app.inject({ method: "GET", url, headers: { cookie } });
        assert.equal(res.statusCode, 200, url);
        assert.ok(!res.body.includes("envVarsEncrypted"), `${url} leaked the column`);
        assert.ok(!res.body.includes("super-secret-value"), `${url} leaked a value`);
      }
    });

    it("masks env var values unless reveal is requested", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      await app.inject({
        method: "PUT",
        url: `/api/applications/${created.id}/env`,
        headers: { cookie },
        payload: { vars: { SECRET_TOKEN: "super-secret-value" } }
      });

      const masked = await app.inject({
        method: "GET",
        url: `/api/applications/${created.id}/env`,
        headers: { cookie }
      });
      assert.equal(masked.statusCode, 200);
      assert.ok(masked.body.includes("SECRET_TOKEN"), "the key should be listed");
      assert.ok(!masked.body.includes("super-secret-value"), "the value must be masked");

      const revealed = await app.inject({
        method: "GET",
        url: `/api/applications/${created.id}/env?reveal=true`,
        headers: { cookie }
      });
      assert.equal(revealed.statusCode, 200);
      assert.ok(revealed.body.includes("super-secret-value"));
    });

    it("stores env vars encrypted at rest", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      await app.inject({
        method: "PUT",
        url: `/api/applications/${created.id}/env`,
        headers: { cookie },
        payload: { vars: { SECRET_TOKEN: "super-secret-value" } }
      });
      const row = await prisma.application.findUniqueOrThrow({
        where: { id: created.id },
        select: { envVarsEncrypted: true }
      });
      assert.ok(row.envVarsEncrypted);
      assert.ok(
        !row.envVarsEncrypted.toString("utf8").includes("super-secret-value"),
        "the plaintext value must not be recoverable from the column"
      );
    });

    it("keeps build variables separate from runtime env vars", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);

      await app.inject({
        method: "PUT",
        url: `/api/applications/${created.id}/env`,
        headers: { cookie },
        payload: { vars: { RUNTIME_ONLY: "runtime-value" } }
      });
      await app.inject({
        method: "PUT",
        url: `/api/applications/${created.id}/build-args`,
        headers: { cookie },
        payload: { vars: { NIXPACKS_NODE_VERSION: "22" } }
      });

      const env = await app.inject({
        method: "GET",
        url: `/api/applications/${created.id}/env?reveal=true`,
        headers: { cookie }
      });
      assert.equal(env.statusCode, 200);
      assert.ok(env.body.includes("RUNTIME_ONLY"));
      assert.ok(
        !env.body.includes("NIXPACKS_NODE_VERSION"),
        "a build variable must not show up as a runtime env var"
      );

      const args = await app.inject({
        method: "GET",
        url: `/api/applications/${created.id}/build-args?reveal=true`,
        headers: { cookie }
      });
      assert.equal(args.statusCode, 200);
      assert.ok(args.body.includes("NIXPACKS_NODE_VERSION"));
      assert.ok(
        !args.body.includes("RUNTIME_ONLY"),
        "a runtime env var must not show up as a build variable"
      );
    });

    it("masks build variable values unless reveal is requested", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      await app.inject({
        method: "PUT",
        url: `/api/applications/${created.id}/build-args`,
        headers: { cookie },
        payload: { vars: { NPM_TOKEN: "npm-secret-value" } }
      });

      const masked = await app.inject({
        method: "GET",
        url: `/api/applications/${created.id}/build-args`,
        headers: { cookie }
      });
      assert.equal(masked.statusCode, 200);
      assert.ok(masked.body.includes("NPM_TOKEN"), "the key should be listed");
      assert.ok(!masked.body.includes("npm-secret-value"), "the value must be masked");

      const revealed = await app.inject({
        method: "GET",
        url: `/api/applications/${created.id}/build-args?reveal=true`,
        headers: { cookie }
      });
      assert.equal(revealed.statusCode, 200);
      assert.ok(revealed.body.includes("npm-secret-value"));
    });

    it("stores build variables encrypted, and never returns the column", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      await app.inject({
        method: "PUT",
        url: `/api/applications/${created.id}/build-args`,
        headers: { cookie },
        payload: { vars: { NPM_TOKEN: "npm-secret-value" } }
      });

      const row = await prisma.application.findUniqueOrThrow({
        where: { id: created.id },
        select: { buildArgsEncrypted: true }
      });
      assert.ok(row.buildArgsEncrypted);
      assert.ok(
        !row.buildArgsEncrypted.toString("utf8").includes("npm-secret-value"),
        "the plaintext value must not be recoverable from the column"
      );

      for (const url of ["/api/applications", `/api/applications/${created.id}`]) {
        const res = await app.inject({ method: "GET", url, headers: { cookie } });
        assert.equal(res.statusCode, 200, url);
        assert.ok(!res.body.includes("buildArgsEncrypted"), `${url} leaked the column`);
        assert.ok(!res.body.includes("npm-secret-value"), `${url} leaked a value`);
      }
    });

    it("patches and clears build variables", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      await app.inject({
        method: "PUT",
        url: `/api/applications/${created.id}/build-args`,
        headers: { cookie },
        payload: { vars: { A: "1", B: "2" } }
      });

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/applications/${created.id}/build-args`,
        headers: { cookie },
        payload: { set: { C: "3" }, unset: ["A"] }
      });
      assert.equal(patched.statusCode, 200, patched.body);

      const listed = await app.inject({
        method: "GET",
        url: `/api/applications/${created.id}/build-args`,
        headers: { cookie }
      });
      assert.deepEqual((listed.json() as { keys: string[] }).keys, ["B", "C"]);

      // Replacing with an empty map clears the column rather than storing `{}`.
      await app.inject({
        method: "PUT",
        url: `/api/applications/${created.id}/build-args`,
        headers: { cookie },
        payload: { vars: {} }
      });
      const cleared = await prisma.application.findUniqueOrThrow({
        where: { id: created.id },
        select: { buildArgsEncrypted: true }
      });
      assert.equal(cleared.buildArgsEncrypted, null);
    });

    it("rejects an empty build variable patch", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      const res = await app.inject({
        method: "PATCH",
        url: `/api/applications/${created.id}/build-args`,
        headers: { cookie },
        payload: {}
      });
      assert.equal(res.statusCode, 400);
    });

    it("presents both maps as one scoped variable list", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      const url = `/api/applications/${created.id}/variables`;

      const put = await app.inject({
        method: "PUT",
        url,
        headers: { cookie },
        payload: {
          vars: [
            { key: "DATABASE_URL", value: "postgres://secret", scope: "runtime" },
            { key: "NIXPACKS_NODE_VERSION", value: "22", scope: "build" },
            { key: "NEXT_PUBLIC_API_URL", value: "https://api.example.test", scope: "both" }
          ]
        }
      });
      assert.equal(put.statusCode, 200, put.body);

      // The scope is derived from the two columns, so this is also a check
      // that the write landed in the right ones.
      const row = await prisma.application.findUniqueOrThrow({
        where: { id: created.id },
        select: { envVarsEncrypted: true, buildArgsEncrypted: true }
      });
      assert.deepEqual(
        Object.keys(decryptJson(row.envVarsEncrypted!) as Record<string, string>).sort(),
        ["DATABASE_URL", "NEXT_PUBLIC_API_URL"]
      );
      assert.deepEqual(
        Object.keys(decryptJson(row.buildArgsEncrypted!) as Record<string, string>).sort(),
        ["NEXT_PUBLIC_API_URL", "NIXPACKS_NODE_VERSION"]
      );

      const listed = await app.inject({ method: "GET", url, headers: { cookie } });
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(
        (listed.json() as { items: { key: string; scope: string }[] }).items.map((i) => [i.key, i.scope]),
        [
          ["DATABASE_URL", "runtime"],
          ["NEXT_PUBLIC_API_URL", "both"],
          ["NIXPACKS_NODE_VERSION", "build"]
        ]
      );
      assert.ok(!listed.body.includes("postgres://secret"), "masked listing leaked a value");

      // The older per-map routes still see their own half.
      const env = await app.inject({
        method: "GET",
        url: `/api/applications/${created.id}/env`,
        headers: { cookie }
      });
      assert.deepEqual((env.json() as { keys: string[] }).keys, ["DATABASE_URL", "NEXT_PUBLIC_API_URL"]);
    });

    it("moves a variable between build and runtime without resending its value", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      const url = `/api/applications/${created.id}/variables`;
      await app.inject({
        method: "PUT",
        url,
        headers: { cookie },
        payload: { vars: [{ key: "SHARED", value: "v", scope: "both" }] }
      });

      const rescoped = await app.inject({
        method: "PATCH",
        url,
        headers: { cookie },
        payload: { rescope: [{ key: "SHARED", scope: "runtime" }] }
      });
      assert.equal(rescoped.statusCode, 200, rescoped.body);

      // Narrowing the scope must actually stop the value reaching the image.
      const row = await prisma.application.findUniqueOrThrow({
        where: { id: created.id },
        select: { envVarsEncrypted: true, buildArgsEncrypted: true }
      });
      assert.equal(row.buildArgsEncrypted, null);
      assert.deepEqual(decryptJson(row.envVarsEncrypted!), { SHARED: "v" });

      const missing = await app.inject({
        method: "PATCH",
        url,
        headers: { cookie },
        payload: { rescope: [{ key: "NOPE", scope: "build" }] }
      });
      assert.equal(missing.statusCode, 400, missing.body);
    });

    it("reveals scoped values only on request, and audits each map it exposed", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      const url = `/api/applications/${created.id}/variables`;
      await app.inject({
        method: "PUT",
        url,
        headers: { cookie },
        payload: {
          vars: [
            { key: "SECRET_TOKEN", value: "runtime-secret", scope: "runtime" },
            { key: "TOOLCHAIN", value: "22", scope: "build" }
          ]
        }
      });

      const revealed = await app.inject({ method: "GET", url: `${url}?reveal=true`, headers: { cookie } });
      assert.equal(revealed.statusCode, 200);
      assert.ok(revealed.body.includes("runtime-secret"));

      const actions = await prisma.auditLog.findMany({ select: { action: true } });
      const names = actions.map((a) => a.action);
      assert.ok(names.includes("env.reveal"), "expected an env reveal to be audited");
      assert.ok(names.includes("build_args.reveal"), "expected a build variable reveal to be audited");
    });

    it("rejects an empty variables patch and a duplicated key", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      const url = `/api/applications/${created.id}/variables`;
      const empty = await app.inject({ method: "PATCH", url, headers: { cookie }, payload: {} });
      assert.equal(empty.statusCode, 400);

      const dupe = await app.inject({
        method: "PUT",
        url,
        headers: { cookie },
        payload: {
          vars: [
            { key: "A", value: "1", scope: "both" },
            { key: "A", value: "2", scope: "runtime" }
          ]
        }
      });
      assert.equal(dupe.statusCode, 400, dupe.body);
    });

    it("deletes an application and its rows", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      const res = await app.inject({
        method: "DELETE",
        url: `/api/applications/${created.id}`,
        headers: { cookie }
      });
      assert.ok(res.statusCode < 400, res.body);
      assert.equal(await prisma.application.count(), 0);
    });
  });

  describe("organization scoping", () => {
    /** A second organization with its own owner, created directly. */
    async function otherOrgApp(): Promise<string> {
      const org = await prisma.organization.create({
        data: { name: "Other", slug: "other" }
      });
      const other = await prisma.application.create({
        data: {
          organizationId: org.id,
          name: "Secret",
          slug: "secret",
          gitRepo: "https://github.com/other/secret"
        }
      });
      return other.id;
    }

    it("hides another organization's applications from the list", async () => {
      const cookie = await signIn();
      await otherOrgApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/applications",
        headers: { cookie }
      });
      assert.deepEqual(res.json(), []);
    });

    it("404s another organization's application by id", async () => {
      const cookie = await signIn();
      const foreignId = await otherOrgApp();
      // 404 rather than 403: existence itself is not disclosed.
      const res = await app.inject({
        method: "GET",
        url: `/api/applications/${foreignId}`,
        headers: { cookie }
      });
      assert.equal(res.statusCode, 404);
    });

    it("refuses to mutate another organization's application", async () => {
      const cookie = await signIn();
      const foreignId = await otherOrgApp();

      for (const [method, url, payload] of [
        ["PATCH", `/api/applications/${foreignId}`, { name: "Hijacked" }],
        ["DELETE", `/api/applications/${foreignId}`, undefined],
        ["POST", `/api/applications/${foreignId}/deploy`, {}],
        ["PUT", `/api/applications/${foreignId}/env`, { vars: { A: "1" } }],
        ["GET", `/api/applications/${foreignId}/env`, undefined],
        ["PUT", `/api/applications/${foreignId}/build-args`, { vars: { A: "1" } }],
        ["GET", `/api/applications/${foreignId}/build-args`, undefined],
        ["GET", `/api/applications/${foreignId}/variables`, undefined],
        ["PUT", `/api/applications/${foreignId}/variables`, { vars: [] }]
      ] as const) {
        const res = await app.inject({ method, url, headers: { cookie }, payload });
        assert.equal(res.statusCode, 404, `${method} ${url} returned ${String(res.statusCode)}`);
      }

      const still = await prisma.application.findUniqueOrThrow({ where: { id: foreignId } });
      assert.equal(still.name, "Secret");
    });
  });

  describe("setup gate", () => {
    it("blocks API routes until unlocked when an installer password is set", async () => {
      process.env.SOHWE_SETUP_PASSWORD = "installer-password";
      const gated = await buildServer(loadApiConfig(), { logger: false });
      try {
        const blocked = await gated.inject({ method: "GET", url: "/api/applications" });
        assert.equal(blocked.statusCode, 403);
        assert.equal(blocked.json().code, "SETUP_GATE_REQUIRED");

        // The endpoints the unlock screen itself needs must stay reachable.
        for (const url of ["/health", "/api/setup/status", "/api/config"]) {
          const res = await gated.inject({ method: "GET", url });
          assert.equal(res.statusCode, 200, `${url} should be allowed through the gate`);
        }

        const wrong = await gated.inject({
          method: "POST",
          url: "/api/setup/unlock",
          payload: { password: "not-the-password" }
        });
        assert.equal(wrong.statusCode, 401);

        const ok = await gated.inject({
          method: "POST",
          url: "/api/setup/unlock",
          payload: { password: "installer-password" }
        });
        assert.equal(ok.statusCode, 200, ok.body);
        const gateCookie = ok.cookies.find((c) => c.name === "sohwe_setup_gate");
        assert.ok(gateCookie, "expected a gate cookie");
        assert.equal(gateCookie.httpOnly, true);

        const unlocked = await gated.inject({
          method: "GET",
          url: "/api/applications",
          headers: { cookie: `sohwe_setup_gate=${gateCookie.value}` }
        });
        // Past the gate, the route falls through to its own auth check.
        assert.equal(unlocked.statusCode, 401);
      } finally {
        await gated.close();
      }
    });

    it("rejects a forged gate cookie", async () => {
      process.env.SOHWE_SETUP_PASSWORD = "installer-password";
      const gated = await buildServer(loadApiConfig(), { logger: false });
      try {
        const payload = Buffer.from(
          JSON.stringify({ v: 1, t: Date.now() }),
          "utf8"
        ).toString("base64url");
        const res = await gated.inject({
          method: "GET",
          url: "/api/applications",
          headers: { cookie: `sohwe_setup_gate=${payload}.${"0".repeat(64)}` }
        });
        assert.equal(res.statusCode, 403);
      } finally {
        await gated.close();
      }
    });

    it("stops gating once a user exists", async () => {
      process.env.SOHWE_SETUP_PASSWORD = "installer-password";
      const gated = await buildServer(loadApiConfig(), { logger: false });
      try {
        await prisma.organization.create({
          data: {
            name: "Acme",
            slug: "acme",
            users: {
              create: { email: OWNER.email, passwordHash: "x", role: "owner" }
            }
          }
        });
        const res = await gated.inject({ method: "GET", url: "/api/applications" });
        assert.equal(res.statusCode, 401, "should be an auth failure, not a gate failure");
      } finally {
        await gated.close();
      }
    });
  });

  describe("GitHub webhook", () => {
    const path = "/api/webhooks/github";

    async function addGitHubInstallation(
      installationId: number
    ): Promise<{ cookie: string; secret: string }> {
      const cookie = await signIn();
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: OWNER.email },
        select: { organizationId: true }
      });
      const secret = "test-webhook-secret";
      await prisma.gitHubApp.create({
        data: {
          organizationId: owner.organizationId,
          appId: 123,
          slug: "sohwe-test",
          name: "Sohwe test",
          clientId: "client-id",
          htmlUrl: "https://github.com/apps/sohwe-test",
          ownerLogin: "owner",
          multiAccount: true,
          credentialsEncrypted: encryptJson({
            pem: "private-key",
            webhookSecret: secret,
            clientSecret: "client-secret"
          }),
          installations: {
            create: {
              installationId,
              accountLogin: "acme",
              accountType: "Organization",
              repositorySelection: "selected"
            }
          }
        }
      });
      return { cookie, secret };
    }

    function signWebhook(secret: string, body: string): string {
      return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    }

    it("rejects an unsigned delivery and records it", async () => {
      const res = await app.inject({
        method: "POST",
        url: path,
        headers: { "content-type": "application/json", "x-github-event": "push" },
        payload: JSON.stringify({ ref: "refs/heads/main" })
      });
      assert.equal(res.statusCode, 401);

      const rows = await prisma.webhookDelivery.findMany();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.verified, false);
      assert.equal(rows[0]?.outcome, "rejected");
      assert.equal(rows[0]?.organizationId, null);
      // Nothing from the unverified payload may be stored.
      assert.equal(rows[0]?.repoFullName, null);
      assert.equal(rows[0]?.branch, null);
    });

    it("rejects a wrong signature", async () => {
      const res = await app.inject({
        method: "POST",
        url: path,
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`
        },
        payload: JSON.stringify({ ref: "refs/heads/main" })
      });
      assert.equal(res.statusCode, 401);
      assert.equal(await prisma.webhookDelivery.count(), 1);
    });

    it("enqueues no deploy for a rejected delivery", async () => {
      await app.inject({
        method: "POST",
        url: path,
        headers: { "content-type": "application/json", "x-github-event": "push" },
        payload: JSON.stringify({ ref: "refs/heads/main" })
      });
      assert.equal(await prisma.deployment.count(), 0);
    });

    it("ignores a validly signed push from an installation not connected to Sohwe", async () => {
      const { secret } = await addGitHubInstallation(101);
      const body = JSON.stringify({
        installation: { id: 999 },
        ref: "refs/heads/main",
        after: "a".repeat(40),
        deleted: false,
        repository: { full_name: "acme/web" },
        head_commit: { message: "Untrusted installation" }
      });
      const res = await app.inject({
        method: "POST",
        url: path,
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-hub-signature-256": signWebhook(secret, body)
        },
        payload: body
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(await prisma.deployment.count(), 0);
      const delivery = await prisma.webhookDelivery.findFirstOrThrow();
      assert.equal(delivery.outcome, "ignored");
      assert.match(delivery.detail ?? "", /has not been connected/);
    });

    it("accepts a signed push from a connected installation", async () => {
      const { cookie, secret } = await addGitHubInstallation(101);
      await createApp(cookie);
      const body = JSON.stringify({
        installation: { id: 101 },
        ref: "refs/heads/main",
        after: "b".repeat(40),
        deleted: false,
        repository: { full_name: "acme/web" },
        head_commit: { message: "Known installation" }
      });
      const res = await app.inject({
        method: "POST",
        url: path,
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-hub-signature-256": signWebhook(secret, body)
        },
        payload: body
      });
      assert.equal(res.statusCode, 200, res.body);
      const delivery = await prisma.webhookDelivery.findFirstOrThrow();
      assert.equal(delivery.outcome, "ignored");
      assert.match(delivery.detail ?? "", /Auto-deploy is off/);
    });

    it("requires authentication to read the delivery log", async () => {
      await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
      const res = await app.inject({ method: "GET", url: "/api/github/deliveries" });
      assert.equal(res.statusCode, 401);
    });

    it("returns unattributed rejections to a signed-in operator", async () => {
      const cookie = await signIn();
      await app.inject({
        method: "POST",
        url: path,
        headers: { "content-type": "application/json", "x-github-event": "push" },
        payload: JSON.stringify({ ref: "refs/heads/main" })
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/github/deliveries",
        headers: { cookie }
      });
      assert.equal(res.statusCode, 200);
      const { deliveries } = res.json() as { deliveries: { outcome: string }[] };
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.outcome, "rejected");
    });
  });

  describe("GitHub app status", () => {
    it("reports not-connected without leaking any credential field", async () => {
      const cookie = await signIn();
      const res = await app.inject({
        method: "GET",
        url: "/api/github/app",
        headers: { cookie }
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.connected, false);
      assert.equal(body.app, null);
      assert.ok(!res.body.includes("credentialsEncrypted"));
      assert.ok(!res.body.includes("webhookSecret"));
      assert.ok(!res.body.includes("pem"));
    });

    it("requires authentication", async () => {
      await app.inject({ method: "POST", url: "/api/setup", payload: OWNER });
      const res = await app.inject({ method: "GET", url: "/api/github/app" });
      assert.equal(res.statusCode, 401);
    });

    it("lists every connected GitHub account without leaking credentials", async () => {
      const cookie = await signIn();
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: OWNER.email },
        select: { organizationId: true }
      });
      await prisma.gitHubApp.create({
        data: {
          organizationId: owner.organizationId,
          appId: 123,
          slug: "sohwe-test",
          name: "Sohwe test",
          clientId: "client-id",
          htmlUrl: "https://github.com/apps/sohwe-test",
          ownerLogin: "owner",
          multiAccount: true,
          credentialsEncrypted: encryptJson({
            pem: "private-key",
            webhookSecret: "webhook-secret",
            clientSecret: "client-secret"
          }),
          installations: {
            create: [
              {
                installationId: 101,
                accountLogin: "acme",
                accountType: "Organization",
                repositorySelection: "selected",
                htmlUrl:
                  "https://github.com/organizations/acme/settings/installations/101"
              },
              {
                installationId: 102,
                accountLogin: "octo",
                accountType: "User",
                repositorySelection: "all",
                htmlUrl: "https://github.com/settings/installations/102"
              }
            ]
          }
        }
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/github/app",
        headers: { cookie }
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as {
        app: {
          installed: boolean;
          multiAccount: boolean;
          installations: Array<{ accountLogin: string }>;
        };
      };
      assert.equal(body.app.installed, true);
      assert.equal(body.app.multiAccount, true);
      assert.deepEqual(
        body.app.installations.map((installation) => installation.accountLogin),
        ["acme", "octo"]
      );
      assert.ok(!res.body.includes("webhook-secret"));
      assert.ok(!res.body.includes("private-key"));
      assert.ok(!res.body.includes("client-secret"));
    });
  });

  describe("role guards", () => {
    it("lets a member read apps but not create, change, or delete them", async () => {
      const ownerCookie = await signIn();
      const created = await createApp(ownerCookie);
      const cookie = await signInAs("member");

      const list = await app.inject({
        method: "GET",
        url: "/api/applications",
        headers: { cookie }
      });
      assert.equal(list.statusCode, 200);
      assert.equal((list.json() as unknown[]).length, 1);

      for (const [method, url, payload] of [
        [
          "POST",
          "/api/applications",
          { name: "Second", slug: "second", gitRepo: "https://github.com/acme/two" }
        ],
        ["PATCH", `/api/applications/${created.id}`, { name: "Renamed" }],
        ["DELETE", `/api/applications/${created.id}`, undefined]
      ] as const) {
        const res = await app.inject({ method, url, headers: { cookie }, payload });
        assert.equal(res.statusCode, 403, `${method} ${url} should be admin-only`);
      }

      // Nothing was created, renamed, or removed.
      const rows = await prisma.application.findMany();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.name, "Web");
    });

    it("lets a member deploy and roll back an existing app", async () => {
      // Operating apps is the whole point of the member role.
      const ownerCookie = await signIn();
      const created = await createApp(ownerCookie);
      const cookie = await signInAs("member");

      const res = await app.inject({
        method: "POST",
        url: `/api/applications/${created.id}/deploy`,
        headers: { cookie }
      });
      assert.equal(res.statusCode, 202, res.body);
      assert.equal(await prisma.deployment.count(), 1);
    });

    it("keeps every secret-adjacent surface away from members", async () => {
      const ownerCookie = await signIn();
      const created = await createApp(ownerCookie);
      const cookie = await signInAs("member");

      for (const [method, url, payload] of [
        // Even the masked read: `maskedPreview` still shows part of a value.
        ["GET", `/api/applications/${created.id}/env`, undefined],
        ["PUT", `/api/applications/${created.id}/env`, { vars: { A: "1" } }],
        ["PATCH", `/api/applications/${created.id}/env`, { set: { A: "1" } }],
        // Build variables hold registry tokens as readily as env vars do.
        ["GET", `/api/applications/${created.id}/build-args`, undefined],
        ["PUT", `/api/applications/${created.id}/build-args`, { vars: { A: "1" } }],
        ["PATCH", `/api/applications/${created.id}/build-args`, { set: { A: "1" } }],
        ["GET", `/api/applications/${created.id}/variables`, undefined],
        ["PUT", `/api/applications/${created.id}/variables`, { vars: [] }],
        [
          "PATCH",
          `/api/applications/${created.id}/variables`,
          { set: [{ key: "A", value: "1", scope: "both" }] }
        ],
        // The container filesystem reaches config files and /proc/self/environ.
        ["GET", `/api/applications/${created.id}/fs/list`, undefined],
        // Alert destination URLs are bearer credentials for a chat channel.
        ["GET", `/api/applications/${created.id}/alert-destinations`, undefined],
        // Datastores carry generated database credentials.
        ["GET", "/api/datastores", undefined],
        // Bundles carry re-encrypted env vars.
        ["GET", "/api/backups", undefined],
        ["GET", "/api/backups/destinations", undefined],
        ["POST", "/api/backups/export", { passphrase: "passphrase-1" }],
        ["GET", "/api/github/app", undefined],
        ["GET", "/api/audit-logs", undefined]
      ] as const) {
        const res = await app.inject({ method, url, headers: { cookie }, payload });
        assert.equal(res.statusCode, 403, `${method} ${url} should be admin-only`);
      }
      assert.equal(await prisma.bundle.count(), 0);
    });

    it("lets an admin do everything except manage roles", async () => {
      await signIn();
      const cookie = await signInAs("admin");

      const created = await app.inject({
        method: "POST",
        url: "/api/applications",
        headers: { cookie },
        payload: {
          name: "Admin App",
          slug: "admin-app",
          gitRepo: "https://github.com/acme/admin-app"
        }
      });
      assert.equal(created.statusCode, 200, created.body);

      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: OWNER.email }
      });
      const promote = await app.inject({
        method: "PATCH",
        url: `/api/members/${owner.id}/role`,
        headers: { cookie },
        payload: { role: "member" }
      });
      assert.equal(promote.statusCode, 403, "role changes are owner-only");
      const stillOwner = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
      assert.equal(stillOwner.role, "owner");
    });

    it("gives an unrecognized role no access at all", async () => {
      await signIn();
      const cookie = await signInAs("superuser", "weird@example.test");
      const res = await app.inject({
        method: "GET",
        url: "/api/applications",
        headers: { cookie }
      });
      // Authenticated, but the role ranks below `member`, so it fails closed.
      assert.equal(res.statusCode, 403);
    });
  });

  describe("members", () => {
    it("lists everyone in the organization and marks the caller", async () => {
      const ownerCookie = await signIn();
      await signInAs("member");
      const res = await app.inject({
        method: "GET",
        url: "/api/members",
        headers: { cookie: ownerCookie }
      });
      assert.equal(res.statusCode, 200);
      const rows = res.json() as { email: string; role: string; isSelf: boolean }[];
      assert.equal(rows.length, 2);
      assert.equal(rows.find((r) => r.email === OWNER.email)?.isSelf, true);
      assert.ok(!res.body.includes("passwordHash"));
      assert.ok(!res.body.includes("argon2"));
    });

    it("lets an owner change another member's role", async () => {
      const ownerCookie = await signIn();
      await signInAs("member");
      const target = await prisma.user.findUniqueOrThrow({
        where: { email: "member@example.test" }
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/members/${target.id}/role`,
        headers: { cookie: ownerCookie },
        payload: { role: "admin" }
      });
      assert.equal(res.statusCode, 200, res.body);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      assert.equal(after.role, "admin");
    });

    it("refuses to demote the only owner", async () => {
      const ownerCookie = await signIn();
      const second = await signInAs("owner", "owner2@example.test");
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: OWNER.email }
      });

      // Two owners: demoting one is fine.
      const ok = await app.inject({
        method: "PATCH",
        url: `/api/members/${owner.id}/role`,
        headers: { cookie: second },
        payload: { role: "admin" }
      });
      assert.equal(ok.statusCode, 200, ok.body);

      // Now there is one owner left, and they cannot demote themselves either.
      const secondUser = await prisma.user.findUniqueOrThrow({
        where: { email: "owner2@example.test" }
      });
      const self = await app.inject({
        method: "PATCH",
        url: `/api/members/${secondUser.id}/role`,
        headers: { cookie: second },
        payload: { role: "member" }
      });
      assert.equal(self.statusCode, 400);
      assert.equal(
        (await prisma.user.count({ where: { role: "owner" } })),
        1,
        "the organization must never be left without an owner"
      );
      // `ownerCookie` still works — demotion does not invalidate sessions.
      const me = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: ownerCookie }
      });
      assert.equal(me.json().role, "admin", "the role change is visible immediately");
    });

    it("removes a member and signs out their sessions", async () => {
      const ownerCookie = await signIn();
      const memberCookie = await signInAs("member");
      const target = await prisma.user.findUniqueOrThrow({
        where: { email: "member@example.test" }
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/members/${target.id}`,
        headers: { cookie: ownerCookie }
      });
      assert.equal(res.statusCode, 200, res.body);

      const after = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: memberCookie }
      });
      assert.equal(after.statusCode, 401, "sessions cascade with the user row");
    });

    it("refuses self-removal and stops an admin removing an owner", async () => {
      const ownerCookie = await signIn();
      const adminCookie = await signInAs("admin");
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: OWNER.email }
      });

      const self = await app.inject({
        method: "DELETE",
        url: `/api/members/${owner.id}`,
        headers: { cookie: ownerCookie }
      });
      assert.equal(self.statusCode, 400);

      const byAdmin = await app.inject({
        method: "DELETE",
        url: `/api/members/${owner.id}`,
        headers: { cookie: adminCookie }
      });
      assert.equal(byAdmin.statusCode, 403);
      assert.ok(await prisma.user.findUnique({ where: { id: owner.id } }));
    });

    it("404s a member of another organization", async () => {
      const cookie = await signIn();
      const org = await prisma.organization.create({
        data: { name: "Other", slug: "other-members" }
      });
      const foreign = await prisma.user.create({
        data: {
          email: "elsewhere@example.test",
          passwordHash: "x",
          role: "member",
          organizationId: org.id
        }
      });
      const res = await app.inject({
        method: "DELETE",
        url: `/api/members/${foreign.id}`,
        headers: { cookie }
      });
      assert.equal(res.statusCode, 404);
      assert.ok(await prisma.user.findUnique({ where: { id: foreign.id } }));
    });
  });

  describe("invitations", () => {
    async function invite(
      cookie: string,
      payload: Record<string, unknown> = {}
    ): Promise<{ token: string; acceptUrl: string; invitation: { id: string } }> {
      const res = await app.inject({
        method: "POST",
        url: "/api/invitations",
        headers: { cookie },
        payload: { email: "new@example.test", role: "member", ...payload }
      });
      assert.equal(res.statusCode, 201, res.body);
      return res.json() as {
        token: string;
        acceptUrl: string;
        invitation: { id: string };
      };
    }

    it("returns the raw token once and stores only its hash", async () => {
      const cookie = await signIn();
      const created = await invite(cookie);
      assert.ok(created.token.length >= 20);
      assert.ok(created.acceptUrl.includes(`token=${encodeURIComponent(created.token)}`));

      const row = await prisma.invitation.findFirstOrThrow();
      assert.notEqual(row.tokenHash, created.token);
      assert.match(row.tokenHash, /^[0-9a-f]{64}$/);

      // The listing must never expose anything usable as a credential.
      const list = await app.inject({
        method: "GET",
        url: "/api/invitations",
        headers: { cookie }
      });
      assert.equal(list.statusCode, 200);
      assert.ok(!list.body.includes(created.token));
      assert.ok(!list.body.includes(row.tokenHash));
      assert.ok(!list.body.includes("tokenHash"));
    });

    it("creates the account, signs it in, and marks the invitation used", async () => {
      const cookie = await signIn();
      const created = await invite(cookie, { role: "admin" });

      const res = await app.inject({
        method: "POST",
        url: "/api/invitations/accept",
        payload: {
          token: created.token,
          name: "New Person",
          password: "another correct horse"
        }
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json().role, "admin");

      const sessionCookie = res.cookies.find((c) => c.name === "sohwe_session");
      assert.ok(sessionCookie, "accepting should sign the new member in");
      assert.equal(sessionCookie.httpOnly, true);

      const me = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: `sohwe_session=${sessionCookie.value}` }
      });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().email, "new@example.test");
      assert.equal(me.json().organization.name, OWNER.organizationName);

      const row = await prisma.invitation.findFirstOrThrow();
      assert.ok(row.acceptedAt);
      assert.ok(row.acceptedById);
    });

    it("refuses to reuse a token", async () => {
      const cookie = await signIn();
      const created = await invite(cookie);
      const accept = () =>
        app.inject({
          method: "POST",
          url: "/api/invitations/accept",
          payload: { token: created.token, name: "Person", password: "password-12345" }
        });

      assert.equal((await accept()).statusCode, 201);
      const second = await accept();
      assert.equal(second.statusCode, 410);
      assert.equal(await prisma.user.count(), 2, "no second account was created");
    });

    it("refuses a revoked, expired, or unknown token", async () => {
      const cookie = await signIn();

      const revoked = await invite(cookie, { email: "revoked@example.test" });
      const revokeRes = await app.inject({
        method: "DELETE",
        url: `/api/invitations/${revoked.invitation.id}`,
        headers: { cookie }
      });
      assert.equal(revokeRes.statusCode, 200, revokeRes.body);

      const expired = await invite(cookie, { email: "expired@example.test" });
      await prisma.invitation.update({
        where: { id: expired.invitation.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      });

      for (const token of [revoked.token, expired.token]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/invitations/accept",
          payload: { token, name: "Person", password: "password-12345" }
        });
        assert.equal(res.statusCode, 410);
      }

      const unknown = await app.inject({
        method: "POST",
        url: "/api/invitations/accept",
        payload: {
          token: "x".repeat(43),
          name: "Person",
          password: "password-12345"
        }
      });
      assert.equal(unknown.statusCode, 404);
      assert.equal(await prisma.user.count(), 1);
    });

    it("looks up a pending invitation without authentication and without secrets", async () => {
      const cookie = await signIn();
      const created = await invite(cookie);
      const res = await app.inject({
        method: "GET",
        url: `/api/invitations/lookup?token=${encodeURIComponent(created.token)}`
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal(body.email, "new@example.test");
      assert.equal(body.organizationName, OWNER.organizationName);
      assert.ok(!("token" in body));
      assert.ok(!("tokenHash" in body));
    });

    it("refuses to invite an address that already has an account", async () => {
      const cookie = await signIn();
      const res = await app.inject({
        method: "POST",
        url: "/api/invitations",
        headers: { cookie },
        payload: { email: OWNER.email, role: "member" }
      });
      assert.equal(res.statusCode, 409);
      assert.equal(await prisma.invitation.count(), 0);
    });

    it("refuses a second pending invitation for the same address", async () => {
      const cookie = await signIn();
      await invite(cookie);
      const res = await app.inject({
        method: "POST",
        url: "/api/invitations",
        headers: { cookie },
        payload: { email: "new@example.test", role: "member" }
      });
      assert.equal(res.statusCode, 409);
      assert.equal(await prisma.invitation.count(), 1);
    });

    it("refuses to grant the owner role by invitation", async () => {
      const cookie = await signIn();
      const res = await app.inject({
        method: "POST",
        url: "/api/invitations",
        headers: { cookie },
        payload: { email: "new@example.test", role: "owner" }
      });
      assert.equal(res.statusCode, 400);
      assert.equal(await prisma.invitation.count(), 0);
    });

    it("keeps invitations out of a member's reach", async () => {
      await signIn();
      const cookie = await signInAs("member");
      for (const [method, url, payload] of [
        ["GET", "/api/invitations", undefined],
        ["POST", "/api/invitations", { email: "x@example.test", role: "member" }]
      ] as const) {
        const res = await app.inject({ method, url, headers: { cookie }, payload });
        assert.equal(res.statusCode, 403, `${method} ${url} should be admin-only`);
      }
    });
  });

  describe("audit log", () => {
    it("records who created, changed, and deleted an application", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      await app.inject({
        method: "PATCH",
        url: `/api/applications/${created.id}`,
        headers: { cookie },
        payload: { name: "Renamed" }
      });
      await app.inject({
        method: "DELETE",
        url: `/api/applications/${created.id}`,
        headers: { cookie }
      });

      const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
      const actions = rows.map((r) => r.action);
      assert.deepEqual(actions, [
        "application.create",
        "application.update",
        "application.delete"
      ]);
      assert.ok(rows.every((r) => r.actorEmail === OWNER.email));
      assert.ok(rows.every((r) => r.targetLabel === "web"));
    });

    it("records env var key names but never values", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      await app.inject({
        method: "PUT",
        url: `/api/applications/${created.id}/env`,
        headers: { cookie },
        payload: { vars: { SECRET_TOKEN: "super-secret-value" } }
      });
      await app.inject({
        method: "GET",
        url: `/api/applications/${created.id}/env?reveal=true`,
        headers: { cookie }
      });

      const rows = await prisma.auditLog.findMany({
        where: { targetType: "env" },
        orderBy: { createdAt: "asc" }
      });
      assert.deepEqual(
        rows.map((r) => r.action),
        ["env.update", "env.reveal"]
      );
      const serialized = JSON.stringify(rows);
      assert.ok(serialized.includes("SECRET_TOKEN"), "the key name is useful");
      assert.ok(!serialized.includes("super-secret-value"), "the value must never be recorded");
    });

    it("records deploys and rollbacks against the acting member", async () => {
      const ownerCookie = await signIn();
      const created = await createApp(ownerCookie);
      const memberCookie = await signInAs("member");
      await app.inject({
        method: "POST",
        url: `/api/applications/${created.id}/deploy`,
        headers: { cookie: memberCookie }
      });

      const row = await prisma.auditLog.findFirstOrThrow({
        where: { action: "deployment.deploy" }
      });
      assert.equal(row.actorEmail, "member@example.test");
      assert.equal(row.targetLabel, "web");
    });

    it("records invitation and membership changes", async () => {
      const cookie = await signIn();
      const invited = await app.inject({
        method: "POST",
        url: "/api/invitations",
        headers: { cookie },
        payload: { email: "new@example.test", role: "member" }
      });
      const { token } = invited.json() as { token: string };
      await app.inject({
        method: "POST",
        url: "/api/invitations/accept",
        payload: { token, name: "New", password: "password-12345" }
      });

      const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
      const actions = rows.map((r) => r.action);
      assert.ok(actions.includes("member.invite"));
      assert.ok(actions.includes("member.join"));
      // The join is attributed to the person who joined, not the inviter.
      const join = rows.find((r) => r.action === "member.join");
      assert.equal(join?.actorEmail, "new@example.test");
      assert.ok(!JSON.stringify(rows).includes(token), "the token must never be logged");
    });

    it("scopes the log to the caller's organization", async () => {
      const cookie = await signIn();
      await createApp(cookie);

      const org = await prisma.organization.create({
        data: { name: "Other", slug: "other-audit" }
      });
      await prisma.auditLog.create({
        data: {
          organizationId: org.id,
          actorId: null,
          actorEmail: "elsewhere@example.test",
          action: "application.create",
          targetType: "application",
          targetLabel: "not-yours"
        }
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/audit-logs",
        headers: { cookie }
      });
      assert.equal(res.statusCode, 200);
      const { items } = res.json() as { items: { targetLabel: string }[] };
      assert.equal(items.length, 1);
      assert.equal(items[0]?.targetLabel, "web");
    });

    it("filters by action and pages with a cursor", async () => {
      const cookie = await signIn();
      const created = await createApp(cookie);
      for (let i = 0; i < 3; i++) {
        await app.inject({
          method: "PATCH",
          url: `/api/applications/${created.id}`,
          headers: { cookie },
          payload: { name: `Rename ${i}` }
        });
      }

      const filtered = await app.inject({
        method: "GET",
        url: "/api/audit-logs?action=application.update",
        headers: { cookie }
      });
      const all = filtered.json() as { items: { action: string }[] };
      assert.equal(all.items.length, 3);
      assert.ok(all.items.every((i) => i.action === "application.update"));

      const firstPage = await app.inject({
        method: "GET",
        url: "/api/audit-logs?action=application.update&limit=2",
        headers: { cookie }
      });
      const page1 = firstPage.json() as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      assert.equal(page1.items.length, 2);
      assert.ok(page1.nextCursor);

      const secondPage = await app.inject({
        method: "GET",
        url: `/api/audit-logs?action=application.update&limit=2&cursor=${page1.nextCursor}`,
        headers: { cookie }
      });
      const page2 = secondPage.json() as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      assert.equal(page2.items.length, 1);
      assert.equal(page2.nextCursor, null);
      const ids = new Set([...page1.items, ...page2.items].map((i) => i.id));
      assert.equal(ids.size, 3, "pages must not overlap");
    });

    it("keeps the trail readable after the actor is removed", async () => {
      const ownerCookie = await signIn();
      const created = await createApp(ownerCookie);
      const memberCookie = await signInAs("member");
      await app.inject({
        method: "POST",
        url: `/api/applications/${created.id}/deploy`,
        headers: { cookie: memberCookie }
      });
      const target = await prisma.user.findUniqueOrThrow({
        where: { email: "member@example.test" }
      });
      await app.inject({
        method: "DELETE",
        url: `/api/members/${target.id}`,
        headers: { cookie: ownerCookie }
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/audit-logs?action=deployment.deploy",
        headers: { cookie: ownerCookie }
      });
      const { items } = res.json() as {
        items: { actor: { email: string; deleted: boolean } }[];
      };
      assert.equal(items.length, 1, "removing a user must not erase their trail");
      assert.equal(items[0]?.actor.email, "member@example.test");
      assert.equal(items[0]?.actor.deleted, true);
    });
  });

  describe("datastores", () => {
    async function createDatastore(
      cookie: string,
      overrides: Record<string, unknown> = {}
    ): Promise<{ id: string; slug: string; status: string }> {
      const res = await app.inject({
        method: "POST",
        url: "/api/datastores",
        headers: { cookie },
        payload: { kind: "postgres", name: "Main DB", slug: "main-db", ...overrides }
      });
      assert.equal(res.statusCode, 201, res.body);
      return res.json() as { id: string; slug: string; status: string };
    }

    function readRowCreds(enc: Uint8Array): Record<string, string> {
      return decryptJson(Buffer.isBuffer(enc) ? enc : Buffer.from(enc));
    }

    it("creates a datastore with generated encrypted credentials and no secret in the response", async () => {
      const cookie = await signIn();
      const created = await createDatastore(cookie);
      assert.equal(created.status, "provisioning");

      const row = await prisma.datastore.findUniqueOrThrow({ where: { id: created.id } });
      const creds = readRowCreds(row.credentialsEncrypted);
      assert.equal(creds.username, "sohwe");
      assert.equal(creds.database, "main_db");
      assert.ok((creds.password ?? "").length >= 24, "expected a generated password");

      // The detail response never carries credential material.
      const res = await app.inject({
        method: "GET",
        url: `/api/datastores/${created.id}`,
        headers: { cookie }
      });
      assert.ok(!res.body.includes("credentialsEncrypted"));
      assert.ok(!res.body.includes(creds.password!));

      const audit = await prisma.auditLog.findFirst({ where: { action: "datastore.create" } });
      assert.ok(audit, "expected a datastore.create audit row");
      assert.ok(!JSON.stringify(audit.metadata).includes(creds.password!));
    });

    it("rejects a duplicate slug and an unsupported engine version", async () => {
      const cookie = await signIn();
      await createDatastore(cookie);
      const dup = await app.inject({
        method: "POST",
        url: "/api/datastores",
        headers: { cookie },
        payload: { kind: "postgres", name: "Again", slug: "main-db" }
      });
      assert.equal(dup.statusCode, 409);

      const badVersion = await app.inject({
        method: "POST",
        url: "/api/datastores",
        headers: { cookie },
        payload: { kind: "postgres", name: "Old", slug: "old-db", engineVersion: "9" }
      });
      assert.equal(badVersion.statusCode, 400);
    });

    it("keeps the password out of the list and reveals it only via /connection, audited", async () => {
      const cookie = await signIn();
      const created = await createDatastore(cookie);
      const row = await prisma.datastore.findUniqueOrThrow({ where: { id: created.id } });
      const password = readRowCreds(row.credentialsEncrypted).password!;

      const list = await app.inject({ method: "GET", url: "/api/datastores", headers: { cookie } });
      assert.equal(list.statusCode, 200);
      assert.ok(!list.body.includes(password));
      assert.ok(!list.body.includes("credentialsEncrypted"));

      const conn = await app.inject({
        method: "GET",
        url: `/api/datastores/${created.id}/connection`,
        headers: { cookie }
      });
      assert.equal(conn.statusCode, 200);
      const c = conn.json() as { url: string; publicUrl: string | null; password: string };
      assert.equal(c.password, password);
      assert.equal(c.url, `postgresql://sohwe:${password}@sohwe-ds-main-db:5432/main_db`);
      assert.equal(c.publicUrl, null);

      const audit = await prisma.auditLog.findFirst({ where: { action: "datastore.reveal" } });
      assert.ok(audit, "revealing connection info must be audited");
    });

    it("assigns a stable public port on enable and clears it on disable", async () => {
      const cookie = await signIn();
      const created = await createDatastore(cookie);
      // The provision job never runs here; settle the row so the toggle is legal.
      await prisma.datastore.update({ where: { id: created.id }, data: { status: "idle" } });

      const on = await app.inject({
        method: "PATCH",
        url: `/api/datastores/${created.id}/public-access`,
        headers: { cookie },
        payload: { enabled: true }
      });
      assert.equal(on.statusCode, 200, on.body);
      const port = (on.json() as { publicPort: number }).publicPort;
      assert.ok(port >= 20000 && port <= 29999, `port ${String(port)} out of range`);

      const conn = await app.inject({
        method: "GET",
        url: `/api/datastores/${created.id}/connection`,
        headers: { cookie }
      });
      const publicUrl = (conn.json() as { publicUrl: string | null }).publicUrl;
      assert.ok(publicUrl?.includes(`:${String(port)}/`), "expected a public URL on the assigned port");

      const off = await app.inject({
        method: "PATCH",
        url: `/api/datastores/${created.id}/public-access`,
        headers: { cookie },
        payload: { enabled: false }
      });
      assert.equal((off.json() as { publicPort: number | null }).publicPort, null);
    });

    it("bind injects the connection URL into the app env; unbind removes it", async () => {
      const cookie = await signIn();
      const application = await createApp(cookie);
      const created = await createDatastore(cookie);
      const row = await prisma.datastore.findUniqueOrThrow({ where: { id: created.id } });
      const password = readRowCreds(row.credentialsEncrypted).password!;

      const bind = await app.inject({
        method: "POST",
        url: `/api/datastores/${created.id}/bindings`,
        headers: { cookie },
        payload: { applicationId: application.id }
      });
      assert.equal(bind.statusCode, 201, bind.body);
      assert.deepEqual((bind.json() as { envKeys: string[] }).envKeys, ["DATABASE_URL"]);

      const env = await app.inject({
        method: "GET",
        url: `/api/applications/${application.id}/env?reveal=true`,
        headers: { cookie }
      });
      const items = (env.json() as { items: { key: string; value: string }[] }).items;
      const injected = items.find((i) => i.key === "DATABASE_URL");
      assert.equal(
        injected?.value,
        `postgresql://sohwe:${password}@sohwe-ds-main-db:5432/main_db`
      );

      const bindAudit = await prisma.auditLog.findFirst({ where: { action: "datastore.bind" } });
      assert.ok(bindAudit);
      assert.ok(!JSON.stringify(bindAudit.metadata).includes(password), "audit must not carry the URL");

      const dup = await app.inject({
        method: "POST",
        url: `/api/datastores/${created.id}/bindings`,
        headers: { cookie },
        payload: { applicationId: application.id }
      });
      assert.equal(dup.statusCode, 409);

      const bindingId = (bind.json() as { id: string }).id;
      const unbind = await app.inject({
        method: "DELETE",
        url: `/api/datastores/${created.id}/bindings/${bindingId}`,
        headers: { cookie }
      });
      assert.equal(unbind.statusCode, 200, unbind.body);

      const envAfter = await app.inject({
        method: "GET",
        url: `/api/applications/${application.id}/env?reveal=true`,
        headers: { cookie }
      });
      const itemsAfter = (envAfter.json() as { items: { key: string }[] }).items;
      assert.equal(itemsAfter.some((i) => i.key === "DATABASE_URL"), false);
      assert.equal(await prisma.datastoreBinding.count(), 0);
    });

    it("delete marks the row deleting and defers destruction to the worker", async () => {
      const cookie = await signIn();
      const created = await createDatastore(cookie);
      const res = await app.inject({
        method: "DELETE",
        url: `/api/datastores/${created.id}`,
        headers: { cookie }
      });
      assert.equal(res.statusCode, 202);
      const row = await prisma.datastore.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(row.status, "deleting");
    });

    it("scopes every datastore route to the caller's organization", async () => {
      const cookie = await signIn();
      const org = await prisma.organization.create({ data: { name: "Other", slug: "other" } });
      const foreign = await prisma.datastore.create({
        data: {
          organizationId: org.id,
          kind: "redis",
          name: "Foreign",
          slug: "foreign",
          engineVersion: "7",
          status: "running",
          credentialsEncrypted: encryptJson({ password: "x" })
        }
      });

      for (const [method, url, payload] of [
        ["GET", `/api/datastores/${foreign.id}`, undefined],
        ["GET", `/api/datastores/${foreign.id}/connection`, undefined],
        ["POST", `/api/datastores/${foreign.id}/rotate-password`, undefined],
        ["PATCH", `/api/datastores/${foreign.id}/public-access`, { enabled: true }],
        ["DELETE", `/api/datastores/${foreign.id}`, undefined]
      ] as const) {
        const res = await app.inject({ method, url, headers: { cookie }, payload });
        assert.equal(res.statusCode, 404, `${method} ${url} returned ${String(res.statusCode)}`);
      }
    });

    it("keeps the whole datastore surface away from members", async () => {
      const ownerCookie = await signIn();
      const created = await createDatastore(ownerCookie);
      const cookie = await signInAs("member");

      for (const [method, url, payload] of [
        ["GET", "/api/datastores", undefined],
        ["POST", "/api/datastores", { kind: "redis", name: "Cache", slug: "cache" }],
        ["GET", `/api/datastores/${created.id}`, undefined],
        ["GET", `/api/datastores/${created.id}/connection`, undefined],
        ["POST", `/api/datastores/${created.id}/provision`, undefined],
        ["POST", `/api/datastores/${created.id}/rotate-password`, undefined],
        ["PATCH", `/api/datastores/${created.id}/public-access`, { enabled: true }],
        ["POST", `/api/datastores/${created.id}/bindings`, { applicationId: created.id }],
        ["DELETE", `/api/datastores/${created.id}`, undefined]
      ] as const) {
        const res = await app.inject({ method, url, headers: { cookie }, payload });
        assert.equal(res.statusCode, 403, `${method} ${url} should be admin-only`);
      }
    });

    it("restores a bundle: fresh credentials, idle status, rewritten bindings", async () => {
      const cookie = await signIn();
      const passphrase = "bundle-pass-1";
      const bundle = buildBundle(
        [
          {
            name: "Restored Web",
            slug: "restored-web",
            gitRepo: "https://github.com/acme/web",
            gitBranch: "main",
            buildMode: "auto",
            buildCmd: null,
            startCmd: null,
            port: 3000,
            domain: null,
            domains: [],
            memoryLimitMb: null,
            cpuLimit: null,
            volumes: [],
            alertDestinations: [],
            envVars: { DATABASE_URL: "postgresql://sohwe:stale@sohwe-ds-r-db:5432/r_db" },
            buildArgs: { NIXPACKS_NODE_VERSION: "22" }
          }
        ],
        {
          passphrase,
          includeSecrets: true,
          source: { orgName: "Source Org", sohweVersion: "0.8.0" },
          createdAtIso: new Date().toISOString()
        },
        [
          {
            kind: "postgres",
            name: "R DB",
            slug: "r-db",
            engineVersion: "16",
            memoryLimitMb: null,
            cpuLimit: null,
            publicPort: null,
            bindings: [{ appSlug: "restored-web", envKeys: ["DATABASE_URL"] }]
          }
        ]
      );

      const preflight = await app.inject({
        method: "POST",
        url: "/api/backups/restore/preflight",
        headers: { cookie },
        payload: { bundle, passphrase }
      });
      assert.equal(preflight.statusCode, 200, preflight.body);
      const pf = preflight.json() as {
        datastores: { slug: string; collides: boolean; bindingCount: number }[];
      };
      assert.deepEqual(pf.datastores, [
        {
          name: "R DB",
          slug: "r-db",
          kind: "postgres",
          engineVersion: "16",
          collides: false,
          bindingCount: 1
        }
      ]);

      const apply = await app.inject({
        method: "POST",
        url: "/api/backups/restore/apply",
        headers: { cookie },
        payload: { bundle, passphrase, collisionPolicy: "rename" }
      });
      assert.equal(apply.statusCode, 200, apply.body);
      const result = apply.json() as {
        created: number;
        datastoresCreated: number;
        bindingsRestored: number;
      };
      assert.equal(result.created, 1);
      assert.equal(result.datastoresCreated, 1);
      assert.equal(result.bindingsRestored, 1);

      const ds = await prisma.datastore.findFirstOrThrow({ where: { slug: "r-db" } });
      assert.equal(ds.status, "idle", "restored datastores must not provision themselves");
      const creds = readRowCreds(ds.credentialsEncrypted);
      assert.notEqual(creds.password, "stale", "restore must generate fresh credentials");

      // The bound app's injected key was rewritten with the new credentials.
      const restoredApp = await prisma.application.findFirstOrThrow({
        where: { slug: "restored-web" }
      });
      const env = decryptJson(Buffer.from(restoredApp.envVarsEncrypted!));
      assert.equal(
        env.DATABASE_URL,
        `postgresql://sohwe:${creds.password!}@sohwe-ds-r-db:5432/r_db`
      );

      // Build variables ride the bundle in their own encrypted block.
      assert.deepEqual(
        decryptJson(Buffer.from(restoredApp.buildArgsEncrypted!)),
        { NIXPACKS_NODE_VERSION: "22" }
      );
      assert.equal(await prisma.datastoreBinding.count(), 1);
    });

    it("still restores a v1 bundle (no datastores section)", async () => {
      const cookie = await signIn();
      const passphrase = "v1-pass";
      const salt = randomBundleSalt();
      const key = deriveBundleKey(passphrase, salt);
      const payload = {
        format: "sohwe-backup",
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        source: { orgName: "Old Instance", sohweVersion: "0.6.0" },
        kdf: {
          algo: "scrypt",
          salt: salt.toString("base64"),
          N: SCRYPT_PARAMS.N,
          r: SCRYPT_PARAMS.r,
          p: SCRYPT_PARAMS.p
        },
        includesSecrets: false,
        apps: [
          {
            name: "Legacy",
            slug: "legacy",
            gitRepo: "https://github.com/acme/legacy",
            gitBranch: "main",
            buildMode: "auto",
            buildCmd: null,
            startCmd: null,
            port: 3000,
            domain: null,
            domains: [],
            memoryLimitMb: null,
            cpuLimit: null,
            volumes: [],
            alertDestinations: []
          }
        ]
      };
      const bundle = {
        ...payload,
        signature: hmacSign(key, canonicalize(payload)).toString("base64")
      };

      const preflight = await app.inject({
        method: "POST",
        url: "/api/backups/restore/preflight",
        headers: { cookie },
        payload: { bundle, passphrase }
      });
      assert.equal(preflight.statusCode, 200, preflight.body);
      assert.deepEqual((preflight.json() as { datastores: unknown[] }).datastores, []);

      const apply = await app.inject({
        method: "POST",
        url: "/api/backups/restore/apply",
        headers: { cookie },
        payload: { bundle, passphrase, collisionPolicy: "rename" }
      });
      assert.equal(apply.statusCode, 200, apply.body);
      const result = apply.json() as { created: number; datastoresCreated: number };
      assert.equal(result.created, 1);
      assert.equal(result.datastoresCreated, 0);
    });
  });

  describe("host filesystem browser", () => {
    /**
     * Build a server whose config carries an allowlist. The env var is read at
     * `loadApiConfig()` time and deleted immediately after, so nothing leaks
     * into the shared `app` (which `beforeEach` builds with the feature off).
     */
    async function buildWithAllowlist(roots: string): Promise<FastifyInstance> {
      process.env.SOHWE_HOST_FS_ALLOWLIST = roots;
      try {
        return await buildServer(loadApiConfig(), { logger: false });
      } finally {
        delete process.env.SOHWE_HOST_FS_ALLOWLIST;
      }
    }

    /** Temp root with a file, a subdirectory, and a symlink escaping the root. */
    async function makeFixture(): Promise<{ root: string; outside: string }> {
      const root = await mkdtemp(join(tmpdir(), "sohwe-hostfs-"));
      const outside = await mkdtemp(join(tmpdir(), "sohwe-hostfs-outside-"));
      await writeFile(join(root, "top.txt"), "hello host\n");
      await mkdir(join(root, "conf"));
      await writeFile(join(root, "conf", "app.txt"), "conf file");
      await writeFile(join(outside, "secret.txt"), "must stay unreachable");
      await symlink(join(outside, "secret.txt"), join(root, "escape"));
      return { root, outside };
    }

    it("is disabled without an allowlist", async () => {
      const cookie = await signIn();

      const status = await app.inject({
        method: "GET",
        url: "/api/host-fs",
        headers: { cookie }
      });
      assert.equal(status.statusCode, 200, status.body);
      assert.deepEqual(status.json(), { enabled: false, roots: [] });

      for (const url of ["/api/host-fs/list", "/api/host-fs/file?path=/etc/hostname"]) {
        const res = await app.inject({ method: "GET", url, headers: { cookie } });
        assert.equal(res.statusCode, 403, `${url} should refuse when disabled`);
      }
    });

    it("lists and reads under an allowlisted root, auditing every access", async () => {
      const cookie = await signIn();
      const { root, outside } = await makeFixture();
      const gated = await buildWithAllowlist(root);
      try {
        const status = await gated.inject({
          method: "GET",
          url: "/api/host-fs",
          headers: { cookie }
        });
        assert.deepEqual(status.json(), { enabled: true, roots: [root] });

        const list = await gated.inject({
          method: "GET",
          url: `/api/host-fs/list?path=${encodeURIComponent(root)}`,
          headers: { cookie }
        });
        assert.equal(list.statusCode, 200, list.body);
        const { entries } = list.json() as {
          entries: { name: string; kind: string }[];
        };
        assert.deepEqual(
          entries.map((e) => `${e.kind}:${e.name}`),
          ["dir:conf", "symlink:escape", "file:top.txt"]
        );

        const file = await gated.inject({
          method: "GET",
          url: `/api/host-fs/file?path=${encodeURIComponent(join(root, "top.txt"))}`,
          headers: { cookie }
        });
        assert.equal(file.statusCode, 200, file.body);
        const body = file.json() as {
          content: string;
          encoding: string;
          truncated: boolean;
        };
        assert.equal(body.content, "hello host\n");
        assert.equal(body.encoding, "utf8");
        assert.equal(body.truncated, false);

        // The roadmap item is "audit every host file list/read action".
        const audits = await prisma.auditLog.findMany({
          where: { action: { in: ["host_fs.list", "host_fs.read"] } },
          orderBy: { createdAt: "asc" }
        });
        assert.deepEqual(
          audits.map((a) => a.action),
          ["host_fs.list", "host_fs.read"]
        );
        assert.equal(audits[0]?.targetLabel, root);
        assert.equal(audits[1]?.targetLabel, join(root, "top.txt"));
      } finally {
        await gated.close();
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects traversal, out-of-root paths, and symlink escapes", async () => {
      const cookie = await signIn();
      const { root, outside } = await makeFixture();
      const gated = await buildWithAllowlist(root);
      try {
        const cases: [string, number][] = [
          // ".." never parses, even when it would stay inside the root.
          [`${root}/conf/../top.txt`, 400],
          // Outside every allowed root.
          [`/definitely-not-allowlisted`, 403],
          [outside, 403],
          // Inside the root lexically, but resolves outside it.
          [join(root, "escape"), 403],
          // Inside the root, but nothing there.
          [join(root, "missing.txt"), 404]
        ];
        for (const [path, expected] of cases) {
          const res = await gated.inject({
            method: "GET",
            url: `/api/host-fs/file?path=${encodeURIComponent(path)}`,
            headers: { cookie }
          });
          assert.equal(
            res.statusCode,
            expected,
            `${path} returned ${String(res.statusCode)}: ${res.body}`
          );
        }

        // Refused access is not "not found": the symlink escape must not leak
        // whether its target exists, and no audit row records a denied path.
        const audits = await prisma.auditLog.count({
          where: { action: { in: ["host_fs.list", "host_fs.read"] } }
        });
        assert.equal(audits, 0);
      } finally {
        await gated.close();
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("is admin-and-above even when enabled", async () => {
      await signIn();
      const cookie = await signInAs("member");
      const { root, outside } = await makeFixture();
      const gated = await buildWithAllowlist(root);
      try {
        for (const url of [
          "/api/host-fs",
          `/api/host-fs/list?path=${encodeURIComponent(root)}`,
          `/api/host-fs/file?path=${encodeURIComponent(join(root, "top.txt"))}`
        ]) {
          const res = await gated.inject({ method: "GET", url, headers: { cookie } });
          assert.equal(res.statusCode, 403, `${url} should be admin-only`);
        }
      } finally {
        await gated.close();
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe("custom domain DNS assist", () => {
    const EXPECTED_IP = "203.0.113.10";
    const CF_TOKEN = "cf-test-token-abc123xyz-00000000";

    /** NS fake: example.com is a Cloudflare-hosted zone; everything else fails. */
    const fakeResolveNs = async (host: string): Promise<string[]> => {
      if (host === "example.com") {
        return ["dee.ns.cloudflare.com", "gail.ns.cloudflare.com"];
      }
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    };

    const fakeResolve4 =
      (answers: Record<string, string[]>) =>
      async (host: string): Promise<string[]> => {
        const a = answers[host];
        if (!a) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        return a;
      };

    /** Answers for a healthy setup: base domain and app domain point here. */
    function healthyAnswers() {
      const baseDomain = loadApiConfig().baseDomain;
      return {
        [baseDomain]: [EXPECTED_IP],
        "app.example.com": [EXPECTED_IP]
      };
    }

    /**
     * Fake Cloudflare API: token verifies, one zone (example.com), no existing
     * records, create succeeds. Calls are recorded for assertions. Route order
     * matters — the dns_records paths must match before the bare /zones prefix.
     */
    function cfFetch() {
      const calls: { url: string; method: string; body: unknown }[] = [];
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      const fetchImpl = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({
          url,
          method,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        });
        const path = url.replace("https://api.cloudflare.com/client/v4", "");
        if (method === "GET" && path.startsWith("/user/tokens/verify")) {
          return json({ success: true, errors: [], result: { status: "active" } });
        }
        if (method === "GET" && path.startsWith("/zones/z1/dns_records")) {
          return json({ success: true, errors: [], result: [] });
        }
        if (method === "POST" && path.startsWith("/zones/z1/dns_records")) {
          return json({ success: true, errors: [], result: { id: "r1" } });
        }
        if (method === "GET" && path.startsWith("/zones")) {
          return json({
            success: true,
            errors: [],
            result: [{ id: "z1", name: "example.com" }],
            result_info: { page: 1, total_pages: 1 }
          });
        }
        return json({
          success: false,
          errors: [{ message: `no fake for ${method} ${path}` }]
        });
      }) as typeof fetch;
      return { fetchImpl, calls };
    }

    /** Id of the one domain an app created with `{ domain: ... }` now holds. */
    async function onlyDomainId(
      server: Awaited<ReturnType<typeof buildServer>>,
      cookie: string,
      appId: string
    ): Promise<string> {
      const res = await server.inject({
        method: "GET",
        url: `/api/applications/${appId}/domains`,
        headers: { cookie }
      });
      assert.equal(res.statusCode, 200, res.body);
      const { domains } = res.json() as { domains: { id: string }[] };
      assert.equal(domains.length, 1, res.body);
      return domains[0]!.id;
    }

    it("inspects a domain: provider, required record, and status", async () => {
      await signIn();
      const memberCookie = await signInAs("member");
      const dnsApp = await buildServer(loadApiConfig(), {
        logger: false,
        dns: { resolveNs: fakeResolveNs, resolve4: fakeResolve4(healthyAnswers()) }
      });
      try {
        // Inspection is member-level: it exposes nothing secret.
        const res = await dnsApp.inject({
          method: "GET",
          url: "/api/dns/inspect?domain=app.example.com",
          headers: { cookie: memberCookie }
        });
        assert.equal(res.statusCode, 200, res.body);
        const body = res.json() as {
          zone: string;
          provider: { id: string; apiSupported: boolean };
          status: string;
          record: { type: string; name: string; value: string };
          expectedIp: string;
        };
        assert.equal(body.zone, "example.com");
        assert.equal(body.provider.id, "cloudflare");
        assert.equal(body.provider.apiSupported, true);
        assert.equal(body.status, "verified");
        assert.deepEqual(body.record, {
          type: "A",
          name: "app.example.com",
          value: EXPECTED_IP
        });

        const unauth = await dnsApp.inject({
          method: "GET",
          url: "/api/dns/inspect?domain=app.example.com"
        });
        assert.equal(unauth.statusCode, 401);
      } finally {
        await dnsApp.close();
      }
    });

    it("reports unresolved and mismatch states", async () => {
      const cookie = await signIn();
      const baseDomain = loadApiConfig().baseDomain;

      const unresolvedApp = await buildServer(loadApiConfig(), {
        logger: false,
        dns: {
          resolveNs: fakeResolveNs,
          resolve4: fakeResolve4({ [baseDomain]: [EXPECTED_IP] })
        }
      });
      try {
        const res = await unresolvedApp.inject({
          method: "GET",
          url: "/api/dns/inspect?domain=app.example.com",
          headers: { cookie }
        });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(res.json().status, "unresolved");
      } finally {
        await unresolvedApp.close();
      }

      const mismatchApp = await buildServer(loadApiConfig(), {
        logger: false,
        dns: {
          resolveNs: fakeResolveNs,
          resolve4: fakeResolve4({
            [baseDomain]: [EXPECTED_IP],
            "app.example.com": ["198.51.100.7"]
          })
        }
      });
      try {
        const res = await mismatchApp.inject({
          method: "GET",
          url: "/api/dns/inspect?domain=app.example.com",
          headers: { cookie }
        });
        assert.equal(res.statusCode, 200, res.body);
        const body = res.json() as { status: string; resolvedIps: string[] };
        assert.equal(body.status, "mismatch");
        assert.deepEqual(body.resolvedIps, ["198.51.100.7"]);
      } finally {
        await mismatchApp.close();
      }
    });

    it("stores the provider token encrypted, admin-and-above, never returned", async () => {
      const cookie = await signIn();
      const memberCookie = await signInAs("member");
      const { fetchImpl } = cfFetch();
      const dnsApp = await buildServer(loadApiConfig(), {
        logger: false,
        dns: {
          resolveNs: fakeResolveNs,
          resolve4: fakeResolve4(healthyAnswers()),
          fetchImpl
        }
      });
      try {
        // The credential surface is admin-and-above, reads included.
        for (const [method, url] of [
          ["PUT", "/api/dns/credentials/cloudflare"],
          ["GET", "/api/dns/credentials"],
          ["DELETE", "/api/dns/credentials/cloudflare"]
        ] as const) {
          const res = await dnsApp.inject({
            method,
            url,
            headers: { cookie: memberCookie },
            ...(method === "PUT" ? { payload: { token: CF_TOKEN } } : {})
          });
          assert.equal(res.statusCode, 403, `${method} ${url} should be admin-only`);
        }

        const put = await dnsApp.inject({
          method: "PUT",
          url: "/api/dns/credentials/cloudflare",
          headers: { cookie },
          payload: { token: CF_TOKEN }
        });
        assert.equal(put.statusCode, 200, put.body);
        assert.ok(!put.body.includes(CF_TOKEN), "token must not be echoed back");

        const list = await dnsApp.inject({
          method: "GET",
          url: "/api/dns/credentials",
          headers: { cookie }
        });
        assert.equal(list.statusCode, 200);
        const creds = list.json() as { credentials: { provider: string }[] };
        assert.deepEqual(
          creds.credentials.map((c) => c.provider),
          ["cloudflare"]
        );
        assert.ok(!list.body.includes(CF_TOKEN), "token must never be listed");

        // Encrypted at rest: the plaintext token is not in the stored bytes.
        const row = await prisma.dnsProviderCredential.findFirstOrThrow();
        assert.ok(
          !Buffer.from(row.tokenEncrypted).toString("latin1").includes(CF_TOKEN)
        );

        // Audited without the secret.
        const audit = await prisma.auditLog.findFirst({
          where: { action: "dns.credentials.set" }
        });
        assert.ok(audit, "expected a dns.credentials.set audit row");
        assert.ok(!JSON.stringify(audit).includes(CF_TOKEN));

        const del = await dnsApp.inject({
          method: "DELETE",
          url: "/api/dns/credentials/cloudflare",
          headers: { cookie }
        });
        assert.equal(del.statusCode, 200);
        const again = await dnsApp.inject({
          method: "DELETE",
          url: "/api/dns/credentials/cloudflare",
          headers: { cookie }
        });
        assert.equal(again.statusCode, 404);
      } finally {
        await dnsApp.close();
      }
    });

    it("rejects a token Cloudflare does not verify", async () => {
      const cookie = await signIn();
      const badVerify = (async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1000, message: "Invalid API Token" }]
          }),
          { status: 401, headers: { "content-type": "application/json" } }
        )) as typeof fetch;
      const dnsApp = await buildServer(loadApiConfig(), {
        logger: false,
        dns: {
          resolveNs: fakeResolveNs,
          resolve4: fakeResolve4(healthyAnswers()),
          fetchImpl: badVerify
        }
      });
      try {
        const res = await dnsApp.inject({
          method: "PUT",
          url: "/api/dns/credentials/cloudflare",
          headers: { cookie },
          payload: { token: CF_TOKEN }
        });
        assert.equal(res.statusCode, 400, res.body);
        assert.match(res.body, /Invalid API Token/);
        assert.equal(await prisma.dnsProviderCredential.count(), 0);
      } finally {
        await dnsApp.close();
      }
    });

    it("applies the record through Cloudflare and audits it", async () => {
      const cookie = await signIn();
      const withDomain = await createApp(cookie, { domain: "app.example.com" });
      const bare = await createApp(cookie, { name: "Bare", slug: "bare" });
      const memberCookie = await signInAs("member");
      const { fetchImpl, calls } = cfFetch();
      const dnsApp = await buildServer(loadApiConfig(), {
        logger: false,
        dns: {
          resolveNs: fakeResolveNs,
          resolve4: fakeResolve4(healthyAnswers()),
          fetchImpl
        }
      });
      try {
        const domainId = await onlyDomainId(dnsApp, cookie, withDomain.id);
        const applyUrl = `/api/applications/${withDomain.id}/domains/${domainId}/dns/apply`;

        // No credential configured yet.
        const early = await dnsApp.inject({
          method: "POST",
          url: applyUrl,
          headers: { cookie }
        });
        assert.equal(early.statusCode, 400);
        assert.match(early.body, /No Cloudflare API token/);

        const put = await dnsApp.inject({
          method: "PUT",
          url: "/api/dns/credentials/cloudflare",
          headers: { cookie },
          payload: { token: CF_TOKEN }
        });
        assert.equal(put.statusCode, 200, put.body);

        // Writing to someone's DNS zone is admin territory.
        const asMember = await dnsApp.inject({
          method: "POST",
          url: applyUrl,
          headers: { cookie: memberCookie }
        });
        assert.equal(asMember.statusCode, 403);

        // A domain id that belongs to a different app is not reachable here.
        const crossApp = await dnsApp.inject({
          method: "POST",
          url: `/api/applications/${bare.id}/domains/${domainId}/dns/apply`,
          headers: { cookie }
        });
        assert.equal(crossApp.statusCode, 404);

        const res = await dnsApp.inject({
          method: "POST",
          url: applyUrl,
          headers: { cookie }
        });
        assert.equal(res.statusCode, 200, res.body);
        const body = res.json() as {
          action: string;
          provider: string;
          zone: string;
          record: { type: string; name: string; value: string };
          proxied: boolean;
        };
        assert.equal(body.action, "created");
        assert.equal(body.provider, "cloudflare");
        assert.equal(body.zone, "example.com");
        assert.deepEqual(body.record, {
          type: "A",
          name: "app.example.com",
          value: EXPECTED_IP
        });
        assert.equal(body.proxied, false);

        // Cloudflare received exactly the record the response reported.
        const create = calls.find((c) => c.method === "POST");
        assert.deepEqual(create?.body, {
          type: "A",
          name: "app.example.com",
          content: EXPECTED_IP,
          ttl: 1,
          proxied: false
        });

        const audit = await prisma.auditLog.findFirst({
          where: { action: "dns.record.apply" }
        });
        assert.ok(audit, "expected a dns.record.apply audit row");
        assert.equal(audit.targetLabel, "app.example.com");
        assert.ok(!JSON.stringify(audit).includes(CF_TOKEN));
      } finally {
        await dnsApp.close();
      }
    });

    it("refuses to auto-apply at a provider with no API integration", async () => {
      const cookie = await signIn();
      // GoDaddy is detected but has no driver, so there is nothing to apply.
      const godaddyNs = async (host: string): Promise<string[]> => {
        if (host === "example.com") {
          return ["ns01.domaincontrol.com", "ns02.domaincontrol.com"];
        }
        throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      };
      const dnsApp = await buildServer(loadApiConfig(), {
        logger: false,
        dns: {
          resolveNs: godaddyNs,
          resolve4: fakeResolve4(healthyAnswers()),
          fetchImpl: cfFetch().fetchImpl
        }
      });
      try {
        const created = await createApp(cookie, { domain: "app.example.com" });
        const domainId = await onlyDomainId(dnsApp, cookie, created.id);
        const res = await dnsApp.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains/${domainId}/dns/apply`,
          headers: { cookie }
        });
        assert.equal(res.statusCode, 400, res.body);
        assert.match(res.body, /cannot write records at GoDaddy/);
      } finally {
        await dnsApp.close();
      }
    });
  });

  describe("custom domains", () => {
    const EXPECTED_IP = "203.0.113.10";

    const fakeResolveNs = async (host: string): Promise<string[]> => {
      if (host === "example.com") {
        return ["dee.ns.cloudflare.com", "gail.ns.cloudflare.com"];
      }
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    };

    const fakeResolve4 =
      (answers: Record<string, string[]>) =>
      async (host: string): Promise<string[]> => {
        const a = answers[host];
        if (!a) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        return a;
      };

    /** Base domain and `app.example.com` both point at this instance. */
    function answers() {
      return {
        [loadApiConfig().baseDomain]: [EXPECTED_IP],
        "app.example.com": [EXPECTED_IP]
      };
    }

    async function domainServer() {
      return buildServer(loadApiConfig(), {
        logger: false,
        dns: { resolveNs: fakeResolveNs, resolve4: fakeResolve4(answers()) }
      });
    }

    type DomainBody = {
      id: string;
      hostname: string;
      isPrimary: boolean;
      redirectTo: string | null;
      lastStatus: string | null;
      verifiedAt: string | null;
    };

    async function listDomains(
      server: Awaited<ReturnType<typeof buildServer>>,
      cookie: string,
      appId: string
    ): Promise<DomainBody[]> {
      const res = await server.inject({
        method: "GET",
        url: `/api/applications/${appId}/domains`,
        headers: { cookie }
      });
      assert.equal(res.statusCode, 200, res.body);
      return (res.json() as { domains: DomainBody[] }).domains;
    }

    it("adds a domain, normalizes it, and checks DNS in the same request", async () => {
      const cookie = await signIn();
      const server = await domainServer();
      try {
        const created = await createApp(cookie);
        const res = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains`,
          headers: { cookie },
          // What someone pastes out of a browser address bar.
          payload: { hostname: "https://App.Example.com/pricing" }
        });
        assert.equal(res.statusCode, 200, res.body);
        const body = res.json() as {
          domain: DomainBody;
          dns: { status: string; provider: { id: string }; record: unknown };
        };
        assert.equal(body.domain.hostname, "app.example.com");
        // The first domain an app gets is its primary; nothing to choose yet.
        assert.equal(body.domain.isPrimary, true);
        assert.equal(body.domain.lastStatus, "verified");
        assert.ok(body.domain.verifiedAt, "expected verifiedAt to be stamped");
        assert.equal(body.dns.status, "verified");
        assert.equal(body.dns.provider.id, "cloudflare");
        assert.deepEqual(body.dns.record, {
          type: "A",
          name: "app.example.com",
          value: EXPECTED_IP
        });

        // The app row's headline URL is the primary domain.
        const apps = await server.inject({
          method: "GET",
          url: "/api/applications",
          headers: { cookie }
        });
        const row = (apps.json() as { id: string; domain: string | null }[]).find(
          (a) => a.id === created.id
        );
        assert.equal(row?.domain, "app.example.com");
      } finally {
        await server.close();
      }
    });

    it("refuses a hostname another application already answers on", async () => {
      const cookie = await signIn();
      const server = await domainServer();
      try {
        const first = await createApp(cookie, { domain: "app.example.com" });
        const second = await createApp(cookie, { name: "Two", slug: "two" });
        const res = await server.inject({
          method: "POST",
          url: `/api/applications/${second.id}/domains`,
          headers: { cookie },
          payload: { hostname: "app.example.com" }
        });
        // Two apps holding one hostname means Traefik cross-routes traffic.
        assert.equal(res.statusCode, 409, res.body);
        assert.equal(await prisma.domain.count(), 1);
        assert.equal(
          (await listDomains(server, cookie, first.id))[0]?.hostname,
          "app.example.com"
        );
      } finally {
        await server.close();
      }
    });

    it("refuses a hostname that is an app's built-in address", async () => {
      const cookie = await signIn();
      const baseDomain = loadApiConfig().baseDomain;
      const server = await domainServer();
      try {
        const created = await createApp(cookie);
        const own = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains`,
          headers: { cookie },
          payload: { hostname: `${created.slug}.${baseDomain}` }
        });
        assert.equal(own.statusCode, 400, own.body);
        assert.match(own.body, /served automatically/);

        const other = await createApp(cookie, { name: "Two", slug: "two" });
        const stealing = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains`,
          headers: { cookie },
          payload: { hostname: `${other.slug}.${baseDomain}` }
        });
        assert.equal(stealing.statusCode, 400, stealing.body);
        assert.match(stealing.body, /built-in address of the app/);
      } finally {
        await server.close();
      }
    });

    it("moves the primary flag and promotes a survivor on delete", async () => {
      const cookie = await signIn();
      const server = await domainServer();
      try {
        const created = await createApp(cookie, { domain: "app.example.com" });
        const add = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains`,
          headers: { cookie },
          payload: { hostname: "www.example.com" }
        });
        assert.equal(add.statusCode, 200, add.body);
        const second = (add.json() as { domain: DomainBody }).domain;
        assert.equal(second.isPrimary, false);

        const promote = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains/${second.id}/primary`,
          headers: { cookie }
        });
        assert.equal(promote.statusCode, 200, promote.body);
        const promoted = (promote.json() as { domains: DomainBody[] }).domains;
        assert.deepEqual(
          promoted.filter((d) => d.isPrimary).map((d) => d.hostname),
          ["www.example.com"]
        );

        // Deleting the primary must leave the app with a headline URL.
        const del = await server.inject({
          method: "DELETE",
          url: `/api/applications/${created.id}/domains/${second.id}`,
          headers: { cookie }
        });
        assert.equal(del.statusCode, 200, del.body);
        const left = (del.json() as { domains: DomainBody[] }).domains;
        assert.deepEqual(
          left.map((d) => [d.hostname, d.isPrimary]),
          [["app.example.com", true]]
        );
      } finally {
        await server.close();
      }
    });

    it("adds a www companion that redirects, and keeps it out of the primary seat", async () => {
      const cookie = await signIn();
      const server = await domainServer();
      try {
        const created = await createApp(cookie, { domain: "example.com" });
        const add = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains`,
          headers: { cookie },
          payload: { hostname: "www.example.com", redirectTo: "example.com" }
        });
        assert.equal(add.statusCode, 200, add.body);
        const www = (add.json() as { domain: DomainBody }).domain;
        assert.equal(www.redirectTo, "example.com");
        // A redirecting domain is never auto-promoted; the target is the URL.
        assert.equal(www.isPrimary, false);

        // Nor can it be promoted by hand while it still redirects.
        const promote = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains/${www.id}/primary`,
          headers: { cookie }
        });
        assert.equal(promote.statusCode, 400, promote.body);
        assert.match(promote.body, /redirects to/);

        // Clearing the redirect turns the hostname back into a served one.
        const clear = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains/${www.id}/redirect`,
          headers: { cookie },
          payload: { target: null }
        });
        assert.equal(clear.statusCode, 200, clear.body);
        const cleared = (clear.json() as { domains: DomainBody[] }).domains;
        assert.deepEqual(
          cleared.map((x) => [x.hostname, x.redirectTo]),
          [
            ["example.com", null],
            ["www.example.com", null]
          ]
        );
      } finally {
        await server.close();
      }
    });

    it("refuses redirect targets that would dead-end or chain", async () => {
      const cookie = await signIn();
      const server = await domainServer();
      try {
        const created = await createApp(cookie, { domain: "example.com" });
        const post = (payload: Record<string, unknown>) =>
          server.inject({
            method: "POST",
            url: `/api/applications/${created.id}/domains`,
            headers: { cookie },
            payload
          });

        // A target the app does not hold is a redirect into a dead name.
        const unknown = await post({
          hostname: "www.example.com",
          redirectTo: "elsewhere.example.com"
        });
        assert.equal(unknown.statusCode, 400, unknown.body);
        assert.match(unknown.body, /not a domain of this app/);

        // `primary` and `redirectTo` contradict each other.
        const primary = await post({
          hostname: "www.example.com",
          redirectTo: "example.com",
          primary: true
        });
        assert.equal(primary.statusCode, 400, primary.body);

        // A redirect into another redirect would chain hops.
        const www = await post({
          hostname: "www.example.com",
          redirectTo: "example.com"
        });
        assert.equal(www.statusCode, 200, www.body);
        const chained = await post({
          hostname: "old.example.com",
          redirectTo: "www.example.com"
        });
        assert.equal(chained.statusCode, 400, chained.body);
        assert.match(chained.body, /itself redirects/);
      } finally {
        await server.close();
      }
    });

    it("clears redirects that pointed at a deleted domain", async () => {
      const cookie = await signIn();
      const server = await domainServer();
      try {
        const created = await createApp(cookie, { domain: "example.com" });
        const add = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains`,
          headers: { cookie },
          payload: { hostname: "www.example.com", redirectTo: "example.com" }
        });
        assert.equal(add.statusCode, 200, add.body);

        const apexId = (await listDomains(server, cookie, created.id)).find(
          (x) => x.hostname === "example.com"
        )!.id;
        const del = await server.inject({
          method: "DELETE",
          url: `/api/applications/${created.id}/domains/${apexId}`,
          headers: { cookie }
        });
        assert.equal(del.statusCode, 200, del.body);
        // The survivor would otherwise bounce visitors into a dead hostname.
        const left = (del.json() as { domains: DomainBody[] }).domains;
        assert.deepEqual(
          left.map((x) => [x.hostname, x.redirectTo, x.isPrimary]),
          [["www.example.com", null, true]]
        );
      } finally {
        await server.close();
      }
    });

    it("lets members read and verify but not change domains", async () => {
      const cookie = await signIn();
      const memberCookie = await signInAs("member");
      const server = await domainServer();
      try {
        const created = await createApp(cookie, { domain: "app.example.com" });
        const domains = await listDomains(server, memberCookie, created.id);
        assert.equal(domains.length, 1);
        const domainId = domains[0]!.id;

        // Re-checking DNS exposes nothing a member cannot already see.
        const verify = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains/${domainId}/verify`,
          headers: { cookie: memberCookie }
        });
        assert.equal(verify.statusCode, 200, verify.body);
        assert.equal(
          (verify.json() as { domain: DomainBody }).domain.lastStatus,
          "verified"
        );

        for (const [method, url, payload] of [
          ["POST", `/api/applications/${created.id}/domains`, { hostname: "b.example.com" }],
          ["POST", `/api/applications/${created.id}/domains/${domainId}/primary`, undefined],
          ["DELETE", `/api/applications/${created.id}/domains/${domainId}`, undefined]
        ] as const) {
          const res = await server.inject({
            method,
            url,
            headers: { cookie: memberCookie },
            payload
          });
          assert.equal(res.statusCode, 403, `${method} ${url} should be admin-only`);
        }
      } finally {
        await server.close();
      }
    });

    it("refuses to suggest or apply a record when the base domain is proxied", async () => {
      const cookie = await signIn();
      const baseDomain = loadApiConfig().baseDomain;
      // A real Cloudflare edge address. The regression: resolving a proxied
      // base domain yields one of these, and Sohwe used to hand it back as the
      // origin — advising people to point domains at Cloudflare itself, which
      // serves Error 1000, and then reporting the result as `verified`.
      const CF_EDGE = "172.67.148.151";
      const server = await buildServer(loadApiConfig(), {
        logger: false,
        dns: {
          resolveNs: fakeResolveNs,
          resolve4: fakeResolve4({
            [baseDomain]: [CF_EDGE],
            "app.example.com": [CF_EDGE]
          })
        }
      });
      try {
        const created = await createApp(cookie);
        const add = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains`,
          headers: { cookie },
          payload: { hostname: "app.example.com" }
        });
        assert.equal(add.statusCode, 200, add.body);
        const body = add.json() as {
          domain: { id: string; lastStatus: string; verifiedAt: string | null };
          dns: { expectedIp: string | null; expectedIpIssue: string | null; record: unknown };
        };

        assert.notEqual(body.domain.lastStatus, "verified");
        assert.equal(body.domain.verifiedAt, null);
        assert.equal(body.dns.expectedIp, null);
        assert.equal(body.dns.record, null, "must not suggest a record it cannot compute");
        assert.match(body.dns.expectedIpIssue ?? "", /proxy address/);
        // The response must never carry the edge address as something to use.
        assert.equal(JSON.stringify(body.dns.record), "null");

        const apply = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains/${body.domain.id}/dns/apply`,
          headers: { cookie }
        });
        assert.equal(apply.statusCode, 400, apply.body);
        assert.match(apply.body, /proxy address|SOHWE_PUBLIC_IP/);
      } finally {
        await server.close();
      }
    });

    it("records domain changes in the audit log", async () => {
      const cookie = await signIn();
      const server = await domainServer();
      try {
        const created = await createApp(cookie);
        const add = await server.inject({
          method: "POST",
          url: `/api/applications/${created.id}/domains`,
          headers: { cookie },
          payload: { hostname: "app.example.com" }
        });
        assert.equal(add.statusCode, 200, add.body);
        const domainId = (add.json() as { domain: DomainBody }).domain.id;

        await server.inject({
          method: "DELETE",
          url: `/api/applications/${created.id}/domains/${domainId}`,
          headers: { cookie }
        });

        const rows = await prisma.auditLog.findMany({
          where: { targetType: "domain" },
          orderBy: { createdAt: "asc" }
        });
        assert.deepEqual(
          rows.map((r) => r.action),
          ["domain.create", "domain.delete"]
        );
        assert.equal(rows[0]?.targetLabel, "app.example.com");
      } finally {
        await server.close();
      }
    });
    });
});
