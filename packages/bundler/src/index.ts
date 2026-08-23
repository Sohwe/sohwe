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
/**
 * Bundle format history:
 * - v1: apps (+ volumes, alert destinations, optional encrypted env vars)
 * - v2: adds a required top-level `datastores` array (managed datastore
 *   config — never credentials or data). `buildBundle` always emits the
 *   current version; `parseBundle` accepts every version listed here.
 * - v3: adds an optional per-app `buildArgs` block (build variables, encrypted
 *   with the same passphrase-derived key as `env`). Additive, but still a
 *   version bump: an older reader strips the unknown key before checking the
 *   signature, so it would report a v2-shaped bundle as corrupt. Rejecting it
 *   as an unsupported version says what actually happened.
 * - v4: adds an optional per-app `domains` array — every custom hostname the
 *   app answers on, not just the primary one. `domain` stays as the primary so
 *   a v4 bundle still carries the field older readers expect; the bump is for
 *   the same signature reason as v3.
 */
export const BUNDLE_VERSION = 4 as const;

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
  /** Primary custom domain, or null when the app has none. */
  domain: string | null;
  /** Every custom domain, primary first. */
  domains: string[];
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  volumes: BundleVolumeInput[];
  alertDestinations: BundleAlertInput[];
  /** Plaintext env vars; only embedded when `includeSecrets` is true. */
  envVars: Record<string, string>;
  /**
   * Plaintext build variables; like `envVars`, only embedded when
   * `includeSecrets` is true. They are encrypted at rest on the source
   * instance and can hold registry tokens, so they are not exported in a
   * secret-free bundle even though most of them are plain build config.
   */
  buildArgs: Record<string, string>;
};

export type BundleDatastoreBindingInput = {
  /** Bound app referenced by slug — ids differ across instances. */
  appSlug: string;
  envKeys: string[];
};

export type BundleDatastoreInput = {
  kind: string;
  name: string;
  slug: string;
  engineVersion: string;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  /** Host-specific; nulled on restore when the port is taken. */
  publicPort: number | null;
  bindings: BundleDatastoreBindingInput[];
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

const DatastoreBindingEntrySchema = z.object({
  appSlug: z.string(),
  envKeys: z.array(z.string())
});

// Config only — no credentials, no data. Restore generates fresh credentials.
const DatastoreEntrySchema = z.object({
  kind: z.string(),
  name: z.string(),
  slug: z.string(),
  engineVersion: z.string(),
  memoryLimitMb: z.number().nullable(),
  cpuLimit: z.number().nullable(),
  publicPort: z.number().nullable(),
  bindings: z.array(DatastoreBindingEntrySchema)
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
  /** The primary custom domain, or null. Present in every version. */
  domain: z.string().nullable(),
  /**
   * v4+. Every custom domain, primary first. Absent in v1-v3 bundles, where
   * `domain` was the only one an app could have.
   */
  domains: z.array(z.string()).optional(),
  memoryLimitMb: z.number().nullable(),
  cpuLimit: z.number().nullable(),
  volumes: z.array(VolumeSchema),
  alertDestinations: z.array(AlertSchema),
  env: z
    .object({ keys: z.array(z.string()), ciphertext: z.string() })
    .optional(),
  /** v3+. Absent in v1/v2 bundles and in secret-free exports. */
  buildArgs: z
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

const ManifestBase = {
  format: z.literal(BUNDLE_FORMAT),
  createdAt: z.string(),
  source: z.object({ orgName: z.string(), sohweVersion: z.string() }),
  kdf: KdfSchema,
  includesSecrets: z.boolean(),
  apps: z.array(AppEntrySchema),
  signature: z.string()
};

/** v1 exactly as shipped in Phase 4.5 — no `datastores` key existed. */
export const BundleManifestV1Schema = z.object({
  ...ManifestBase,
  version: z.literal(1)
});

/**
 * v2 requires `datastores` (possibly empty). Required, not optional: zod
 * strips unknown keys before the signature is checked over the canonicalized
 * parse result, so a field the schema does not keep would silently change
 * what gets signed versus what gets verified.
 */
export const BundleManifestV2Schema = z.object({
  ...ManifestBase,
  version: z.literal(2),
  datastores: z.array(DatastoreEntrySchema)
});

/** v3 is v2 plus the optional per-app `buildArgs` block on `AppEntrySchema`. */
export const BundleManifestV3Schema = z.object({
  ...ManifestBase,
  version: z.literal(3),
  datastores: z.array(DatastoreEntrySchema)
});

/** v4 is v3 plus the optional per-app `domains` array on `AppEntrySchema`. */
export const BundleManifestV4Schema = z.object({
  ...ManifestBase,
  version: z.literal(4),
  datastores: z.array(DatastoreEntrySchema)
});

export const BundleManifestSchema = z.discriminatedUnion("version", [
  BundleManifestV1Schema,
  BundleManifestV2Schema,
  BundleManifestV3Schema,
  BundleManifestV4Schema
]);

/** The manifest `buildBundle` emits (always the current version). */
export type BundleManifest = z.infer<typeof BundleManifestV4Schema>;
/** Any version `parseBundle` accepts. */
export type AnyBundleManifest = z.infer<typeof BundleManifestSchema>;
export type BundleAppEntry = z.infer<typeof AppEntrySchema>;
export type BundleDatastoreEntry = z.infer<typeof DatastoreEntrySchema>;

/** App config with env vars and build variables decrypted by `parseBundle`. */
export type ParsedBundleApp = Omit<
  BundleAppEntry,
  "env" | "buildArgs" | "domains"
> & {
  envVars: Record<string, string>;
  /** Empty for pre-v3 bundles and for exports made without secrets. */
  buildArgs: Record<string, string>;
  /**
   * Always present, so restore has one field to read: a pre-v4 bundle's single
   * `domain` is widened into a one-element list here.
   */
  domains: string[];
};

export type ParsedBundle = {
  version: number;
  createdAt: string;
  source: { orgName: string; sohweVersion: string };
  includesSecrets: boolean;
  apps: ParsedBundleApp[];
  /** Empty for v1 bundles, which predate managed datastores. */
  datastores: BundleDatastoreEntry[];
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
  opts: BuildBundleOptions,
  datastores: BundleDatastoreInput[] = []
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
      domains: a.domains,
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

    if (opts.includeSecrets && Object.keys(a.buildArgs).length > 0) {
      const ciphertext = encryptUtf8(
        JSON.stringify(a.buildArgs),
        key
      ).toString("base64");
      entry.buildArgs = { keys: Object.keys(a.buildArgs).sort(), ciphertext };
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
    apps: appEntries,
    datastores: datastores.map((d) => ({
      kind: d.kind,
      name: d.name,
      slug: d.slug,
      engineVersion: d.engineVersion,
      memoryLimitMb: d.memoryLimitMb,
      cpuLimit: d.cpuLimit,
      publicPort: d.publicPort,
      bindings: d.bindings.map((b) => ({
        appSlug: b.appSlug,
        envKeys: [...b.envKeys]
      }))
    }))
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

  const decryptBlock = (
    block: { ciphertext: string } | undefined
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!block) return out;
    const json = decryptToUtf8(Buffer.from(block.ciphertext, "base64"), key);
    const obj: unknown = JSON.parse(json);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
    }
    return out;
  };

  const apps: ParsedBundleApp[] = manifest.apps.map((a) => {
    const { env, buildArgs, domains, ...rest } = a;
    return {
      ...rest,
      envVars: decryptBlock(env),
      buildArgs: decryptBlock(buildArgs),
      domains: domains ?? (rest.domain ? [rest.domain] : [])
    };
  });

  return {
    version: manifest.version,
    createdAt: manifest.createdAt,
    source: manifest.source,
    includesSecrets: manifest.includesSecrets,
    apps,
    datastores: manifest.version === 1 ? [] : manifest.datastores
  };
}
