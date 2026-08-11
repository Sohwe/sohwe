import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider
} from "fastify-type-provider-zod";
import argon2 from "argon2";
import { prisma } from "@sohwe/db";
import {
  FirstRunSetupSchema,
  LoginSchema,
  SetupUnlockSchema
} from "@sohwe/types";
import {
  buildSetupStatus,
  clearSetupGateCookie,
  cookieSecure,
  setSetupGateCookie,
  setupGateHook,
  verifyUnlockPassword
} from "./setup-gate";
import { registerAlertDestinationRoutes } from "./routes/alert-destinations";
import { registerAppFilesystemRoutes } from "./routes/app-filesystem";
import { registerBackupRoutes } from "./routes/backups";
import { registerApplicationRoutes } from "./routes/applications";
import {
  backfillRepoFullNames,
  registerGitHubRoutes
} from "./routes/github";
import { registerGitHubWebhookRoutes } from "./routes/github-webhook";
import { registerEnvVarRoutes } from "./routes/env-vars";
import { registerVolumeRoutes } from "./routes/volumes";
import { type ApiConfig, loadApiConfig } from "./env";
import { startSessionCleanup } from "./session";

// Fail fast on a misconfigured environment, before opening a socket. process.exit
// returns `never`, so `config` is definitely an ApiConfig past this point.
function loadConfigOrExit(): ApiConfig {
  try {
    return loadApiConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
const config = loadConfigOrExit();

const app = Fastify({
  logger: true,
  // Behind Traefik + the dashboard nginx proxy, which set X-Forwarded-For.
  // Required for per-IP rate limiting to see the real client instead of the
  // proxy's address. The API is never exposed directly, so trusting the proxy
  // chain is safe here.
  trustProxy: true
}).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

await app.register(cors, {
  origin: config.corsOrigin,
  credentials: true
});
await app.register(cookie, { secret: config.sessionSecret });
await app.register(sensible);
// Registered globally but opt-in: only routes that set `config.rateLimit` are
// limited (see the auth routes below). A blanket limit would break the
// dashboard's frequent metrics polling and long-lived SSE streams.
await app.register(rateLimit, { global: false });

// Throttle the two unauthenticated, internet-facing credential endpoints. Keyed
// by client IP; a burst past the limit gets 429 until the window rolls over.
const AUTH_RATE_LIMIT = {
  rateLimit: { max: 10, timeWindow: "1 minute" }
} as const;

app.addHook("onRequest", setupGateHook);

app.get("/health", async () => ({
  status: "ok",
  timestamp: new Date().toISOString()
}));

// Public read-only config consumed by the dashboard (no auth, no secrets).
// `baseDomain` drives the `<slug>.<base-domain>` URL display next to apps
// and on the deploy form. Plumbed through from sohwe.env via compose so
// operators can change the domain without rebuilding the dashboard image.
app.get("/api/config", async () => ({
  baseDomain: process.env.SOHWE_BASE_DOMAIN ?? "sohwe.localhost"
}));

app.get("/api/setup/status", async (req) => buildSetupStatus(req));

app.post(
  "/api/setup/unlock",
  { schema: { body: SetupUnlockSchema }, config: AUTH_RATE_LIMIT },
  async (req, reply) => {
    const pwd = process.env.SOHWE_SETUP_PASSWORD;
    if (!pwd?.length) {
      return reply.badRequest(
        "Installer password is not configured on this instance."
      );
    }
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      return reply.conflict("Setup has already been completed");
    }
    if (!verifyUnlockPassword(req.body.password)) {
      return reply.unauthorized("Invalid installer password");
    }
    setSetupGateCookie(reply);
    return { ok: true };
  }
);

app.post(
  "/api/setup",
  { schema: { body: FirstRunSetupSchema } },
  async (req, reply) => {
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      return reply.conflict("Setup has already been completed");
    }

    const { email, password, name, organizationName } = req.body;
    const passwordHash = await argon2.hash(password);

    const org = await prisma.organization.create({
      data: {
        name: organizationName,
        slug: organizationName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        users: {
          create: {
            email,
            name,
            passwordHash,
            role: "owner"
          }
        }
      },
      include: { users: true }
    });

    clearSetupGateCookie(reply);
    return { ok: true, organizationId: org.id };
  }
);

app.post(
  "/api/auth/login",
  { schema: { body: LoginSchema }, config: AUTH_RATE_LIMIT },
  async (req, reply) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.unauthorized("Invalid credentials");

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) return reply.unauthorized("Invalid credentials");

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const session = await prisma.session.create({
      data: { userId: user.id, expiresAt }
    });

    reply.setCookie("sohwe_session", session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure(),
      path: "/",
      expires: expiresAt
    });

    return { id: user.id, email: user.email, name: user.name };
  }
);

app.post("/api/auth/logout", async (req, reply) => {
  const sessionId = req.cookies.sohwe_session;
  if (sessionId) {
    await prisma.session.deleteMany({ where: { id: sessionId } }).catch(() => {});
  }
  reply.clearCookie("sohwe_session", { path: "/" });
  return { ok: true };
});

app.get("/api/me", async (req, reply) => {
  const sessionId = req.cookies.sohwe_session;
  if (!sessionId) return reply.unauthorized();

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { include: { organization: true } } }
  });
  if (!session || session.expiresAt < new Date()) {
    return reply.unauthorized();
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    organization: {
      id: session.user.organization.id,
      name: session.user.organization.name
    }
  };
});

await registerApplicationRoutes(app);
await registerEnvVarRoutes(app);
await registerVolumeRoutes(app);
await registerAlertDestinationRoutes(app);
await registerAppFilesystemRoutes(app);
await registerBackupRoutes(app);
await registerGitHubRoutes(app, config);
await registerGitHubWebhookRoutes(app);

await app.listen({ port: config.port, host: "0.0.0.0" });

// One-off for installs predating Phase 5: derive `repoFullName` from `gitRepo`
// so existing apps can match incoming push webhooks.
void backfillRepoFullNames(app.log);

// Sweep expired session rows so the table doesn't grow without bound. Sessions
// are already rejected past expiry at read time; this reclaims the storage.
const stopSessionCleanup = startSessionCleanup(app.log);

process.on("SIGTERM", async () => {
  stopSessionCleanup();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
});