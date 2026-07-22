import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@sohwe/db";

const COOKIE_NAME = "sohwe_setup_gate";

// Server-side lifetime of the setup-gate cookie, matching the client-side
// maxAge set in setSetupGateCookie. The signed `t` timestamp is checked against
// this so a leaked cookie can't unlock setup indefinitely.
const GATE_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Whether to set the `Secure` flag on auth cookies. We tie it to whether
// HTTPS is actually serving traffic (set by the installer when SOHWE_HOST
// is configured), NOT to NODE_ENV. HTTP-only deploys (no domain, dashboard
// reachable only at http://<ip>:<port>) are explicitly supported by the
// installer; on those, browsers refuse to store `Secure` cookies received
// over plain HTTP, and unlock/login appear to succeed but never persist.
export function cookieSecure(): boolean {
  return process.env.SOHWE_HTTPS_ENABLED === "true";
}

function verifyInstallPassword(input: string, expected: string): boolean {
  const ha = createHash("sha256").update(input, "utf8").digest();
  const hb = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function signGateCookie(secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1 as const, t: Date.now() }),
    "utf8"
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyGateCookie(
  raw: string | undefined,
  secret: string | undefined
): boolean {
  if (!raw || !secret) return false;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    if (!timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }
  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as { v?: number; t?: number };
    if (data.v !== 1) return false;
    // Enforce the signed issue time. A missing or expired timestamp is invalid.
    if (typeof data.t !== "number" || !Number.isFinite(data.t)) return false;
    const age = Date.now() - data.t;
    return age >= 0 && age < GATE_COOKIE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

export async function buildSetupStatus(req: FastifyRequest): Promise<{
  needsSetup: boolean;
  setupGateActive: boolean;
  setupUnlocked: boolean;
}> {
  const userCount = await prisma.user.count();
  const needsSetup = userCount === 0;
  const gateSecret = process.env.SOHWE_SETUP_PASSWORD;
  const setupGateActive = Boolean(
    needsSetup && gateSecret && gateSecret.length > 0
  );
  const secret = process.env.SESSION_SECRET;
  const setupUnlocked =
    setupGateActive && verifyGateCookie(req.cookies[COOKIE_NAME], secret);
  return {
    needsSetup,
    setupGateActive,
    setupUnlocked
  };
}

export function clearSetupGateCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}

export function setSetupGateCookie(reply: FastifyReply): void {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return;
  const token = signGateCookie(secret);
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    maxAge: 7 * 24 * 60 * 60
  });
}

export async function setupGateHook(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const path = req.url.split("?")[0] ?? "";

  if (path === "/health") return;

  const gateSecret = process.env.SOHWE_SETUP_PASSWORD;
  if (!gateSecret || gateSecret.length === 0) return;

  if (path === "/api/setup/status") return;
  if (path === "/api/setup/unlock" && req.method === "POST") return;
  // /api/config is a non-secret read; the dashboard fetches it on every
  // page render, including the unlock screen.
  if (path === "/api/config" && req.method === "GET") return;

  const userCount = await prisma.user.count();
  if (userCount > 0) return;

  const secret = process.env.SESSION_SECRET;
  if (verifyGateCookie(req.cookies[COOKIE_NAME], secret)) return;

  if (!path.startsWith("/api/")) return;

  await reply.code(403).send({
    message:
      "Enter the installer password first (Setup unlock). Use POST /api/setup/unlock.",
    code: "SETUP_GATE_REQUIRED"
  });
}

export function verifyUnlockPassword(password: string): boolean {
  const expected = process.env.SOHWE_SETUP_PASSWORD;
  if (!expected || expected.length === 0) return false;
  return verifyInstallPassword(password, expected);
}
