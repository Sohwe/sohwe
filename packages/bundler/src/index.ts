import {
  decryptToUtf8,
  deriveBundleKey,
  encryptUtf8,
  hmacSign,
  hmacVerify,
  randomBundleSalt,
  SCRYPT_PARAMS
} from "@sohwe/crypto";
import { z } from "zod";

export const BUNDLE_FORMAT = "sohwe-backup" as const;
export const BUNDLE_VERSION = 1 as const;

// --- Input shapes (plaintext, supplied by the API) -------------------------

export type BundleVolumeInput = {
  mountPath: string;
  /** BigInt is not JSON-safe; the API passes a decimal string or null. */
  sizeBytes: string | null;
};

export type BundleAlertInput = {
  type: string;
  name: string;
  url: string;
  enabled: boolean;
};

export type BundleAppInput = {
  name: string;
  slug: string;
  gitRepo: string;
  gitBranch: string;
  buildMode: string;
  buildCmd: string | null;
  startCmd: string | null;
  port: number;
  domain: string | null;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  volumes: BundleVolumeInput[];
  alertDestinations: BundleAlertInput[];
  /** Plaintext env vars; only embedded when `includeSecrets` is true. */
  envVars: Record<string, string>;
};

export type BuildBundleOptions = {
  passphrase: string;
  includeSecrets: boolean;
  source: { orgName: string; sohweVersion: string };
  /** ISO timestamp stamped by the caller (the bundler stays time-free). */
  createdAtIso: string;
};

// --- Manifest (the serialized bundle document) -----------------------------

const VolumeSchema = z.object({
  mountPath: z.string(),
  sizeBytes: z.string().nullable()
});

const AlertSchema = z.object({
  type: z.string(),
  name: z.string(),
  url: z.string(),
  enabled: z.boolean()
});

const AppEntrySchema = z.object({
  name: z.string(),
  slug: z.string(),
  gitRepo: z.string(),
  gitBranch: z.string(),
  buildMode: z.string(),
  buildCmd: z.string().nullable(),
  startCmd: z.string().nullable(),
  port: z.number(),
  domain: z.string().nullable(),
  memoryLimitMb: z.number().nullable(),
  cpuLimit: z.number().nullable(),
  volumes: z.array(VolumeSchema),
  alertDestinations: z.array(AlertSchema),
  env: z
    .object({ keys: z.array(z.string()), ciphertext: z.string() })
    .optional()
});

const KdfSchema = z.object({
  algo: z.literal("scrypt"),
  salt: z.string(),
  N: z.number(),
  r: z.number(),
  p: z.number()
});

export const BundleManifestSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  createdAt: z.string(),
  source: z.object({ orgName: z.string(), sohweVersion: z.string() }),
  kdf: KdfSchema,
  includesSecrets: z.boolean(),
  apps: z.array(AppEntrySchema),
  signature: z.string()
});

export type BundleManifest = z.infer<typeof BundleManifestSchema>;
export type BundleAppEntry = z.infer<typeof AppEntrySchema>;

/** App config with env vars decrypted, returned by `parseBundle`. */
export type ParsedBundleApp = Omit<BundleAppEntry, "env"> & {
  envVars: Record<string, string>;
};

export type ParsedBundle = {
  createdAt: string;
  source: { orgName: string; sohweVersion: string };
  includesSecrets: boolean;
  apps: ParsedBundleApp[];
};

/**
 * Deterministic JSON with recursively sorted object keys, so the signature is
 * stable regardless of property insertion order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`
  );
  return `{${parts.join(",")}}`;
}

/**
 * Build a signed, passphrase-protected bundle. The passphrase always derives
 * an HMAC key that signs the manifest (tamper-evidence + a shared secret for
 * restore); when `includeSecrets` is set, the same key also AES-encrypts each
 * app's env vars.
 */
export function buildBundle(
  apps: BundleAppInput[],
  opts: BuildBundleOptions
): BundleManifest {
  const salt = randomBundleSalt();
  const key = deriveBundleKey(opts.passphrase, salt);

  const appEntries: BundleAppEntry[] = apps.map((a) => {
    const entry: BundleAppEntry = {
      name: a.name,
      slug: a.slug,
      gitRepo: a.gitRepo,
      gitBranch: a.gitBranch,
      buildMode: a.buildMode,
      buildCmd: a.buildCmd,
      startCmd: a.startCmd,
      port: a.port,
      domain: a.domain,
      memoryLimitMb: a.memoryLimitMb,
      cpuLimit: a.cpuLimit,
      volumes: a.volumes.map((v) => ({
        mountPath: v.mountPath,
        sizeBytes: v.sizeBytes
      })),
      alertDestinations: a.alertDestinations.map((d) => ({
        type: d.type,
        name: d.name,
        url: d.url,
        enabled: d.enabled
      }))
    };

    if (opts.includeSecrets && Object.keys(a.envVars).length > 0) {
      const ciphertext = encryptUtf8(
        JSON.stringify(a.envVars),
        key
      ).toString("base64");
      entry.env = { keys: Object.keys(a.envVars).sort(), ciphertext };
    }

    return entry;
  });

  const payload = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: opts.createdAtIso,
    source: opts.source,
    kdf: {
      algo: "scrypt" as const,
      salt: salt.toString("base64"),
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p
    },
    includesSecrets: opts.includeSecrets,
    apps: appEntries
  };

  const signature = hmacSign(key, canonicalize(payload)).toString("base64");
  return { ...payload, signature };
}

/**
 * Validate and decrypt a bundle. Throws a friendly error when the passphrase
 * is wrong or the bundle has been altered (both surface as a signature
 * mismatch), and a distinct error when the document shape is unrecognized.
 */
export function parseBundle(raw: unknown, passphrase: string): ParsedBundle {
  const parsed = BundleManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Unrecognized or unsupported bundle format");
  }
  const manifest = parsed.data;

  const salt = Buffer.from(manifest.kdf.salt, "base64");
  const key = deriveBundleKey(passphrase, salt);

  const { signature, ...payload } = manifest;
  const sigBuf = Buffer.from(signature, "base64");
  if (!hmacVerify(key, canonicalize(payload), sigBuf)) {
    throw new Error("Invalid passphrase or corrupted bundle");
  }

  const apps: ParsedBundleApp[] = manifest.apps.map((a) => {
    const { env, ...rest } = a;
    const envVars: Record<string, string> = {};
    if (env) {
      const json = decryptToUtf8(Buffer.from(env.ciphertext, "base64"), key);
      const obj: unknown = JSON.parse(json);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          if (typeof v === "string") envVars[k] = v;
        }
      }
    }
    return { ...rest, envVars };
  });

  return {
    createdAt: manifest.createdAt,
    source: manifest.source,
    includesSecrets: manifest.includesSecrets,
    apps
  };
}
