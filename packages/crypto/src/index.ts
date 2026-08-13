import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * 32-byte key from `SOHWE_ENCRYPTION_KEY`.
 * Shared between API and worker; never log or return this to clients.
 *
 * Base64 of 32 bytes (44 chars) is the documented format. A 64-char hex
 * string is also accepted: installers before v0.6.0 generated hex, and hex
 * characters are all valid base64 — decoding to 48 bytes, never 32 — so the
 * two formats cannot collide. A hex key could never have encrypted anything
 * (it always threw here), so accepting it now cannot misread existing data.
 */
export function getSohweEncryptionKey(): Buffer {
  const raw = process.env.SOHWE_ENCRYPTION_KEY;
  if (!raw?.trim()) {
    throw new Error("SOHWE_ENCRYPTION_KEY is not set or is empty");
  }
  const value = raw.trim();
  const b64 = Buffer.from(value, "base64");
  if (b64.length === 32) {
    return b64;
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }
  throw new Error(
    "SOHWE_ENCRYPTION_KEY must be exactly 32 bytes (AES-256), as base64 (44 chars) or hex (64 chars)"
  );
}

/**
 * Ciphertext layout: `iv (12) | tag (16) | ciphertext`
 */
export function encryptUtf8(plaintext: string, key: Buffer = getSohweEncryptionKey()): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptToUtf8(buf: Buffer, key: Buffer = getSohweEncryptionKey()): string {
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("Invalid ciphertext: too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function encryptJson(
  obj: Record<string, string>,
  key?: Buffer
): Buffer {
  return encryptUtf8(JSON.stringify(obj), key ?? getSohweEncryptionKey());
}

export function decryptJson(buf: Buffer, key?: Buffer): Record<string, string> {
  const raw = decryptToUtf8(buf, key ?? getSohweEncryptionKey());
  const parsed: unknown = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("env vars payload must be a JSON object with string values");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(`env var value for ${k} must be a string`);
    }
    out[k] = v;
  }
  return out;
}

const PREVIEW_HEAD = 4;
const PREVIEW_TAIL = 4;

/**
 * Masks a secret for list views (e.g. `sk_l***8abx` when long enough, else `****`).
 */
export function maskedPreview(value: string): string {
  if (!value) return "—";
  if (value.length <= PREVIEW_HEAD + PREVIEW_TAIL) return "••••";
  return `${value.slice(0, PREVIEW_HEAD)}•••${value.slice(-PREVIEW_TAIL)}`;
}

/** Docker `Env` name=value entries for a variable map. */
export function toDockerEnvList(vars: Record<string, string>): string[] {
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`);
}

// --- Passphrase-derived keys for portable bundles (Phase 4.5) --------------
//
// Portable bundles move between Sohwe instances, so they cannot use the
// instance `SOHWE_ENCRYPTION_KEY`. Instead a 32-byte key is derived from a
// user passphrase with scrypt (salt stored in the bundle). The same derived
// key both AES-encrypts the bundled env vars and HMAC-signs the manifest, so a
// correct passphrase is required to read secrets *and* to pass signature
// verification. These parameters are recorded in the bundle for portability.

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const DERIVED_KEY_LEN = 32;
const SCRYPT_SALT_LEN = 16;

/** Random salt for `deriveBundleKey` (store alongside the ciphertext). */
export function randomBundleSalt(): Buffer {
  return randomBytes(SCRYPT_SALT_LEN);
}

/** Derive a 32-byte AES/HMAC key from a passphrase + salt via scrypt. */
export function deriveBundleKey(passphrase: string, salt: Buffer): Buffer {
  if (!passphrase) throw new Error("Passphrase is required");
  return scryptSync(passphrase, salt, DERIVED_KEY_LEN, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    // scrypt's default maxmem is too low for N=16384; raise it explicitly.
    maxmem: 64 * 1024 * 1024
  });
}

/** HMAC-SHA256 of `data` under `key`. */
export function hmacSign(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Constant-time verification of an HMAC-SHA256 signature. */
export function hmacVerify(key: Buffer, data: string, signature: Buffer): boolean {
  const expected = hmacSign(key, data);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(expected, signature);
}
