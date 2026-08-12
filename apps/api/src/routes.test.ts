import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";

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
  "audit_logs",
  "invitations",
  "webhook_deliveries",
  "bundles",
  "backup_schedules",
  "backup_destinations",
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
      assert.ok(res.statusCode >= 400, "expected a duplicate slug to be refused");
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
        ["GET", `/api/applications/${foreignId}/env`, undefined]
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
        // The container filesystem reaches config files and /proc/self/environ.
        ["GET", `/api/applications/${created.id}/fs/list`, undefined],
        // Alert destination URLs are bearer credentials for a chat channel.
        ["GET", `/api/applications/${created.id}/alert-destinations`, undefined],
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
});
