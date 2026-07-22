import { getSohweEncryptionKey } from "@sohwe/crypto";

// Boot-time environment validation. The goal is fail-fast: a misconfigured
// instance should refuse to start with one clear message listing everything
// wrong, instead of booting and failing later in a confusing place — an unset
// SESSION_SECRET silently disabling the setup-gate cookie, or a bad
// SOHWE_ENCRYPTION_KEY only throwing when the worker first decrypts env vars
// mid-deploy.

export type ApiConfig = {
  port: number;
  sessionSecret: string;
  databaseUrl: string;
  redisUrl: string;
  httpsEnabled: boolean;
  baseDomain: string;
  setupPassword: string | null;
  /**
   * Value passed to `@fastify/cors` `origin`. In production the dashboard is
   * served same-origin through nginx, so the default is `false` (no
   * cross-origin access). In development the Vite dev server on :3000 calls the
   * API on :3001, so the default is that origin.
   */
  corsOrigin: boolean | string | string[];
};

const MIN_SESSION_SECRET_LEN = 16;

function requireEnv(errors: string[], name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    errors.push(`${name} is required but is not set`);
    return "";
  }
  return v;
}

function resolveCorsOrigin(): boolean | string | string[] {
  const raw = process.env.SOHWE_CORS_ORIGIN;
  if (raw && raw.trim().length > 0) {
    if (raw.trim() === "*") return true;
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 1) return parts[0]!;
    if (parts.length > 1) return parts;
  }
  // No explicit origin configured.
  if (process.env.NODE_ENV === "production") {
    // Same-origin through nginx; cross-origin requests are not expected.
    return false;
  }
  return "http://localhost:3000";
}

export function loadApiConfig(): ApiConfig {
  const errors: string[] = [];

  const databaseUrl = requireEnv(errors, "DATABASE_URL");
  const redisUrl = requireEnv(errors, "REDIS_URL");

  const sessionSecret = requireEnv(errors, "SESSION_SECRET");
  if (
    sessionSecret.length > 0 &&
    sessionSecret.length < MIN_SESSION_SECRET_LEN
  ) {
    errors.push(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LEN} characters ` +
        `(got ${sessionSecret.length})`
    );
  }

  // Validate the encryption key eagerly. Without this it only throws the first
  // time something encrypts or decrypts, which in the API is a request handler
  // and in the worker is mid-deploy — long after a bad key could have been
  // caught at boot. Must decode to exactly 32 bytes (AES-256).
  try {
    getSohweEncryptionKey();
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const portRaw = process.env.PORT ?? "3001";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    errors.push(`PORT must be a valid TCP port (got "${portRaw}")`);
  }

  if (errors.length > 0) {
    throw new Error(
      "Invalid environment configuration:\n" +
        errors.map((e) => `  - ${e}`).join("\n") +
        "\nSee apps/api/.env.example for the expected values."
    );
  }

  const setupPassword = process.env.SOHWE_SETUP_PASSWORD;

  return {
    port,
    sessionSecret,
    databaseUrl,
    redisUrl,
    httpsEnabled: process.env.SOHWE_HTTPS_ENABLED === "true",
    baseDomain: process.env.SOHWE_BASE_DOMAIN ?? "sohwe.localhost",
    setupPassword: setupPassword && setupPassword.length > 0 ? setupPassword : null,
    corsOrigin: resolveCorsOrigin()
  };
}
