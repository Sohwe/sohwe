import { z } from "zod";

export const FirstRunSetupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  organizationName: z.string().min(1)
});
export type FirstRunSetupInput = z.infer<typeof FirstRunSetupSchema>;

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});
export type LoginInput = z.infer<typeof LoginSchema>;

/** First-access installer password (dashboard unlock before owner setup). */
export const SetupUnlockSchema = z.object({
  password: z.string().min(8)
});
export type SetupUnlockInput = z.infer<typeof SetupUnlockSchema>;

/**
 * Loose domain validation: lowercase labels separated by dots, 1-253 chars.
 * We intentionally avoid a full RFC 1035 / IDN check — Traefik rejects
 * garbage for us at route-install time.
 */
export const DomainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "Must be a valid domain like app.example.com"
  );

const OptionalDomain = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .pipe(DomainSchema.optional());

/**
 * Turn what people actually paste into a bare hostname: a copied address bar
 * ("https://app.example.com/pricing"), a trailing root dot, stray whitespace,
 * or mixed case. Anything left over still has to satisfy `DomainSchema`, so
 * this widens what is *accepted*, never what is *valid*.
 */
export function normalizeHostname(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

/** Body for `POST /api/applications/:id/domains`. */
export const CreateDomainSchema = z.object({
  hostname: z.string().transform(normalizeHostname).pipe(DomainSchema),
  /** Make this the app's primary domain, demoting any current one. */
  primary: z.boolean().default(false)
});
export type CreateDomainInput = z.infer<typeof CreateDomainSchema>;

export const CreateApplicationSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  gitRepo: z.string().url(),
  gitBranch: z.string().default("main"),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  buildMode: z.enum(["auto", "dockerfile", "nixpacks"]).default("auto"),
  buildCmd: z.string().optional(),
  startCmd: z.string().optional(),
  domain: OptionalDomain,
  /** Deploy on every push to `gitBranch` (Phase 5; needs a connected GitHub App). */
  autoDeploy: z.boolean().default(false)
});
export type CreateApplicationInput = z.infer<typeof CreateApplicationSchema>;

/**
 * Partial update for application settings (Phase 2). Everything is optional;
 * the server only touches keys that are actually present.
 *
 * Custom domains are deliberately absent: an app can carry several, and they
 * are managed through `/api/applications/:id/domains` so that adding one can
 * also check DNS and claim the hostname exclusively. `CreateApplicationSchema`
 * still takes a `domain` purely as a shortcut for the first one.
 */
export const UpdateApplicationSchema = z
  .object({
    name: z.string().min(1).optional(),
    gitBranch: z.string().min(1).optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    buildMode: z.enum(["auto", "dockerfile", "nixpacks"]).optional(),
    buildCmd: z.string().nullable().optional(),
    startCmd: z.string().nullable().optional(),
    memoryLimitMb: z
      .union([
        z.null(),
        z.coerce.number().int().min(16).max(65536)
      ])
      .optional(),
    cpuLimit: z
      .union([z.null(), z.coerce.number().min(0.1).max(64)])
      .optional(),
    autoDeploy: z.boolean().optional()
  })
  .partial();
export type UpdateApplicationInput = z.infer<typeof UpdateApplicationSchema>;

export const RollbackBodySchema = z.object({
  sourceDeploymentId: z.string().uuid()
});
export type RollbackBody = z.infer<typeof RollbackBodySchema>;

/** Query for container filesystem browser (Phase 3 preview — running container paths). */
export const FsPathQuerySchema = z.object({
  path: z
    .string()
    .optional()
    .transform((p) => (p === undefined || p === "" ? "/" : p))
});
export type FsPathQuery = z.infer<typeof FsPathQuerySchema>;

/** HTTP env var name (e.g. `NODE_ENV`, `API_KEY_2`). */
export const EnvKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid env var name")
  .max(128);

const MAX_ENV_VALUE_LEN = 32_768;

export const EnvVarsReplaceSchema = z.object({
  vars: z.record(EnvKeySchema, z.string().max(MAX_ENV_VALUE_LEN))
});
export type EnvVarsReplace = z.infer<typeof EnvVarsReplaceSchema>;

export const EnvVarsPatchSchema = z.object({
  set: z.record(EnvKeySchema, z.string().max(MAX_ENV_VALUE_LEN)).optional(),
  unset: z.array(EnvKeySchema).optional()
});
export type EnvVarsPatch = z.infer<typeof EnvVarsPatchSchema>;

export const EnvQuerySchema = z.object({
  reveal: z
    .string()
    .optional()
    .transform((s) => s === "true" || s === "1")
});
export type EnvQuery = z.infer<typeof EnvQuerySchema>;

/**
 * Build-time variables. Same wire shape as runtime env vars — a flat
 * `KEY=value` map — but a different lifetime and a different threat model:
 * the builder passes these to `nixpacks build --env` / `docker build
 * --build-arg`, so they are baked into image layers and readable via
 * `docker history`. Kept as separate schemas from the env var ones so the two
 * surfaces can diverge (limits, validation) without touching each other.
 */
export const BuildArgsReplaceSchema = z.object({
  vars: z.record(EnvKeySchema, z.string().max(MAX_ENV_VALUE_LEN))
});
export type BuildArgsReplace = z.infer<typeof BuildArgsReplaceSchema>;

export const BuildArgsPatchSchema = z.object({
  set: z.record(EnvKeySchema, z.string().max(MAX_ENV_VALUE_LEN)).optional(),
  unset: z.array(EnvKeySchema).optional()
});
export type BuildArgsPatch = z.infer<typeof BuildArgsPatchSchema>;

/**
 * Where a variable is injected. Railway-style: one list, and each entry says
 * which side of the lifecycle sees it.
 *
 * - `runtime` — decrypted into the container's `Env` at create time. Secrets
 *   belong here: nothing about them reaches the image.
 * - `build` — passed to `nixpacks build --env` / `docker build --build-arg`.
 *   Toolchain pins (`NIXPACKS_NODE_VERSION`) and registry credentials.
 * - `both` — the default, for values a framework inlines at build *and* the
 *   process reads at runtime (`NEXT_PUBLIC_*`, `NODE_ENV`).
 *
 * The scope is not stored as a field: it is derived from which of the app's two
 * encrypted maps hold the key, so this vocabulary is a wire concern only.
 */
export const VariableScopeSchema = z.enum(["runtime", "build", "both"]);
export type VariableScope = z.infer<typeof VariableScopeSchema>;

export const VariableEntrySchema = z.object({
  key: EnvKeySchema,
  value: z.string().max(MAX_ENV_VALUE_LEN),
  scope: VariableScopeSchema.default("both")
});
export type VariableEntry = z.infer<typeof VariableEntrySchema>;

/** Replaces every variable on the app — both maps are rewritten. */
export const VariablesReplaceSchema = z.object({
  vars: z.array(VariableEntrySchema).max(500)
});
export type VariablesReplace = z.infer<typeof VariablesReplaceSchema>;

/**
 * Change a variable's scope without resending its value — the masked list has
 * no plaintext to resend, and forcing a reveal to move a key between build and
 * runtime would mean decrypting every secret to adjust one.
 */
export const VariableRescopeSchema = z.object({
  key: EnvKeySchema,
  scope: VariableScopeSchema
});
export type VariableRescope = z.infer<typeof VariableRescopeSchema>;

export const VariablesPatchSchema = z.object({
  set: z.array(VariableEntrySchema).max(500).optional(),
  rescope: z.array(VariableRescopeSchema).max(500).optional(),
  unset: z.array(EnvKeySchema).max(500).optional()
});
export type VariablesPatch = z.infer<typeof VariablesPatchSchema>;

/**
 * Absolute path under which a named volume is mounted; must be non-root with no `..`.
 */
export const VolumeCreateSchema = z.object({
  mountPath: z
    .string()
    .min(2)
    .max(255)
    .regex(
      /^\/[A-Za-z0-9._\-/]+$/,
      "Must be an absolute path like /app/data (no ..)"
    )
    .refine((p) => !p.includes("..") && p !== "/" && p.length >= 2, "Invalid path"),
  sizeBytes: z.coerce.number().int().positive().optional()
});
export type VolumeCreateInput = z.infer<typeof VolumeCreateSchema>;

/**
 * Live container resource sample exposed by `GET /api/applications/:id/stats`.
 * `running: false` means there is no current sample (no running container or
 * the worker's short-TTL Redis key has expired).
 */
export type AppStats =
  | { running: false }
  | {
      running: true;
      cpuPercent: number;
      memUsedBytes: number;
      memLimitBytes: number;
      memPercent: number;
      ts: number;
    };

/** Webhook crash-alert destination kinds. */
export const AlertDestinationTypeSchema = z.enum([
  "discord",
  "slack",
  "generic"
]);
export type AlertDestinationType = z.infer<typeof AlertDestinationTypeSchema>;

export const CreateAlertDestinationSchema = z.object({
  type: AlertDestinationTypeSchema,
  name: z.string().min(1).max(100),
  url: z.string().url(),
  enabled: z.boolean().default(true)
});
export type CreateAlertDestinationInput = z.infer<
  typeof CreateAlertDestinationSchema
>;

export const UpdateAlertDestinationSchema = z
  .object({
    type: AlertDestinationTypeSchema.optional(),
    name: z.string().min(1).max(100).optional(),
    url: z.string().url().optional(),
    enabled: z.boolean().optional()
  })
  .partial();
export type UpdateAlertDestinationInput = z.infer<
  typeof UpdateAlertDestinationSchema
>;

// --- Phase 4.5: Portable config bundles ------------------------------------

/** Backup destination kinds. */
export const BackupDestinationKindSchema = z.enum(["local", "s3"]);
export type BackupDestinationKind = z.infer<typeof BackupDestinationKindSchema>;

/** Absolute filesystem path for a local backup destination (no `..`). */
const LocalDestPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^\/[A-Za-z0-9._\-/]+$/, "Must be an absolute path like /var/sohwe/backups")
  .refine((p) => !p.includes(".."), "Path must not contain ..");

/** Public (non-secret) config for an S3-compatible destination. */
export const S3DestConfigSchema = z.object({
  bucket: z.string().min(1).max(255),
  region: z.string().min(1).max(64),
  /** Custom endpoint for S3-compatible providers (MinIO, R2, Spaces, …). */
  endpoint: z.string().url().max(512).optional(),
  /** Key prefix within the bucket; bundles are written under `<prefix>/<filename>`. */
  prefix: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9._\-/]*$/, "Prefix may only contain letters, numbers, . _ - /")
    .refine((p) => !p.includes(".."), "Prefix must not contain ..")
    .optional(),
  /** Force path-style addressing (required by most S3-compatible servers). */
  forcePathStyle: z.boolean().optional()
});
export type S3DestConfig = z.infer<typeof S3DestConfigSchema>;

/** S3 credentials, supplied on create and stored encrypted at rest. */
export const S3CredentialsSchema = z.object({
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(256)
});
export type S3Credentials = z.infer<typeof S3CredentialsSchema>;

export const CreateBackupDestinationSchema = z.discriminatedUnion("kind", [
  z.object({
    name: z.string().min(1).max(100),
    kind: z.literal("local"),
    config: z.object({ path: LocalDestPathSchema })
  }),
  z.object({
    name: z.string().min(1).max(100),
    kind: z.literal("s3"),
    config: S3DestConfigSchema,
    credentials: S3CredentialsSchema
  })
]);
export type CreateBackupDestinationInput = z.infer<
  typeof CreateBackupDestinationSchema
>;

/** Minimum passphrase length for bundle encryption/signing. */
export const BUNDLE_PASSPHRASE_MIN = 8;

export const BackupExportSchema = z.object({
  passphrase: z.string().min(BUNDLE_PASSPHRASE_MIN),
  includeSecrets: z.boolean().default(true),
  /** When set, write to this destination; otherwise the bundle is downloaded. */
  destinationId: z.string().uuid().optional()
});
export type BackupExportInput = z.infer<typeof BackupExportSchema>;

/** How to handle a restored app whose slug already exists in the org. */
export const SlugCollisionPolicySchema = z.enum([
  "rename",
  "overwrite",
  "skip"
]);
export type SlugCollisionPolicy = z.infer<typeof SlugCollisionPolicySchema>;

export const RestorePreflightSchema = z.object({
  bundle: z.record(z.string(), z.unknown()),
  passphrase: z.string().min(1)
});
export type RestorePreflightInput = z.infer<typeof RestorePreflightSchema>;

export const RestoreApplySchema = RestorePreflightSchema.extend({
  collisionPolicy: SlugCollisionPolicySchema
});
export type RestoreApplyInput = z.infer<typeof RestoreApplySchema>;

// --- Scheduled exports & retention -----------------------------------------

/**
 * Lightweight 5-field cron shape check (minute hour day-of-month month
 * day-of-week). Strict validation happens server-side with `cron-parser`.
 */
export const CronSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (s) => s.split(/\s+/).length === 5,
    "Cron must have 5 space-separated fields (e.g. 0 3 * * *)"
  )
  .refine(
    (s) => s.split(/\s+/).every((f) => /^[0-9*/,-]+$/.test(f)),
    "Cron fields may only contain digits and * / , -"
  );

/** Keep at most this many of a schedule's most recent bundles. */
const RetentionCountSchema = z.number().int().min(1).max(1000);

export const CreateBackupScheduleSchema = z.object({
  destinationId: z.string().uuid(),
  cron: CronSchema,
  includeSecrets: z.boolean().default(true),
  passphrase: z.string().min(BUNDLE_PASSPHRASE_MIN),
  retentionCount: RetentionCountSchema.optional(),
  enabled: z.boolean().default(true)
});
export type CreateBackupScheduleInput = z.infer<
  typeof CreateBackupScheduleSchema
>;

export const UpdateBackupScheduleSchema = z
  .object({
    cron: CronSchema.optional(),
    includeSecrets: z.boolean().optional(),
    passphrase: z.string().min(BUNDLE_PASSPHRASE_MIN).optional(),
    /** `null` clears retention (keep everything); omit to leave unchanged. */
    retentionCount: RetentionCountSchema.nullable().optional(),
    enabled: z.boolean().optional()
  })
  .refine((v) => Object.keys(v).length > 0, "No fields to update");
export type UpdateBackupScheduleInput = z.infer<
  typeof UpdateBackupScheduleSchema
>;

// --- Phase 6: Multi-user ----------------------------------------------------

/**
 * Organization roles, ordered from most to least privileged.
 *
 * - `owner`   full control, including managing other owners and the org itself
 * - `admin`   everything operational: apps, env vars, volumes, backups, Git,
 *             and inviting/removing members — but cannot touch owners
 * - `member`  read-only, plus deploying and rolling back existing apps
 *
 * Secret-adjacent surfaces (env var values, the container file browser, backup
 * export/restore) require `admin` or higher; see `apps/api/src/rbac.ts`.
 */
export const ROLES = ["owner", "admin", "member"] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Roles an invitation may grant. Owners are only ever promoted by an owner. */
export const InvitableRoleSchema = z.enum(["admin", "member"]);
export type InvitableRole = z.infer<typeof InvitableRoleSchema>;

/** How long a freshly minted invitation link stays valid, in days. */
export const INVITATION_TTL_DAYS = 7;

export const CreateInvitationSchema = z.object({
  // Normalize before validating: a pasted address often carries whitespace, and
  // the duplicate checks against users and pending invitations compare exact
  // strings, so casing has to be gone by the time the row is written.
  email: z.string().trim().toLowerCase().email().max(320),
  role: InvitableRoleSchema.default("member")
});
export type CreateInvitationInput = z.infer<typeof CreateInvitationSchema>;

/** Raw invitation token as it appears in a join link. */
export const InvitationTokenSchema = z.string().min(20).max(200);

/** Public, pre-auth lookup of an invitation by token (no secrets in reply). */
export const InvitationLookupSchema = z.object({
  token: InvitationTokenSchema
});
export type InvitationLookupInput = z.infer<typeof InvitationLookupSchema>;

/** Redeem an invitation by creating the account it was addressed to. */
export const AcceptInvitationSchema = z.object({
  token: InvitationTokenSchema,
  name: z.string().min(1).max(200),
  password: z.string().min(8).max(200)
});
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;

export const UpdateMemberRoleSchema = z.object({
  role: RoleSchema
});
export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleSchema>;

/** Filters for `GET /api/audit-logs`. */
export const AuditLogQuerySchema = z.object({
  action: z.string().max(64).optional(),
  targetType: z.string().max(32).optional(),
  targetId: z.string().max(64).optional(),
  actorId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque cursor: the `id` of the last row from the previous page. */
  cursor: z.string().uuid().optional()
});
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

/** Docker named volume for a persist mount (Prisma `Volume.id`). */
export function appDockerVolumeName(
  appId: string,
  volumeId: string
): string {
  return `sohwe_app_${appId}_${volumeId}`;
}

/** Per-app isolated internal Docker network. */
export function appInternalNetworkName(appId: string): string {
  return `sohwe_app_${appId}_net`;
}
// --- Phase 7: Managed datastores --------------------------------------------

export const DATASTORE_KINDS = ["postgres", "redis"] as const;
export const DatastoreKindSchema = z.enum(DATASTORE_KINDS);
export type DatastoreKind = z.infer<typeof DatastoreKindSchema>;

/** Engine versions a datastore may run, per kind; index 0 is the default. */
export const POSTGRES_ENGINE_VERSIONS = ["16", "17"] as const;
export const REDIS_ENGINE_VERSIONS = ["7"] as const;

export function datastoreEngineVersions(kind: DatastoreKind): readonly string[] {
  return kind === "postgres" ? POSTGRES_ENGINE_VERSIONS : REDIS_ENGINE_VERSIONS;
}

/** Default env var key a binding injects, per kind. */
export function datastoreDefaultEnvKey(kind: DatastoreKind): string {
  return kind === "postgres" ? "DATABASE_URL" : "REDIS_URL";
}

/** In-container service port, per kind. */
export function datastoreServicePort(kind: DatastoreKind): number {
  return kind === "postgres" ? 5432 : 6379;
}

export const CreateDatastoreSchema = z.object({
  kind: DatastoreKindSchema,
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/),
  /** Defaults to the kind's first supported version; validated per kind server-side. */
  engineVersion: z.string().max(8).optional(),
  memoryLimitMb: z.coerce.number().int().min(16).max(65536).optional(),
  cpuLimit: z.coerce.number().min(0.1).max(64).optional()
});
export type CreateDatastoreInput = z.infer<typeof CreateDatastoreSchema>;

export const CreateDatastoreBindingSchema = z.object({
  applicationId: z.string().uuid(),
  /** Defaults to DATABASE_URL (postgres) / REDIS_URL (redis). */
  envKey: EnvKeySchema.optional()
});
export type CreateDatastoreBindingInput = z.infer<
  typeof CreateDatastoreBindingSchema
>;

/** Toggle Railway-style public access (a published host port) for a datastore. */
export const DatastorePublicAccessSchema = z.object({
  enabled: z.boolean()
});
export type DatastorePublicAccessInput = z.infer<
  typeof DatastorePublicAccessSchema
>;

/**
 * Host port range for publicly exposed datastores. Below the Linux ephemeral
 * range (32768+) so a published port cannot collide with an outgoing socket.
 */
export const DATASTORE_PUBLIC_PORT_MIN = 20000;
export const DATASTORE_PUBLIC_PORT_MAX = 29999;

/** Docker named volume holding a managed datastore's data. */
export function datastoreVolumeName(datastoreId: string): string {
  return `sohwe_datastore_${datastoreId}_data`;
}

/**
 * Container name for a managed datastore — also its DNS name on the internal
 * networks of bound apps, i.e. the host in injected connection strings. Docker
 * caps container names at 63 characters.
 */
export function datastoreContainerName(slug: string): string {
  return `sohwe-ds-${slug}`.replace(/[^a-z0-9-]/g, "-").slice(0, 63);
}

/**
 * Label carrying the datastore id on its container and volume. Datastore
 * containers deliberately do NOT get a `sohwe.app` label: the worker's stats
 * sampler, crash watcher, and log-tail recovery all key off that label, so its
 * absence is what keeps datastores out of the per-app subsystems.
 */
export const DATASTORE_LABEL = "sohwe.datastore";

/** Decrypted datastore credentials as stored in `credentialsEncrypted`. */
export type DatastoreCredentials = {
  username?: string;
  password: string;
  database?: string;
};

/**
 * Connection URL for a datastore. Passwords are generated base64url, so no
 * URL-encoding is needed. `host`/`port` decide which URL this is: the
 * container DNS name + service port for the internal URL bound apps use, or
 * the instance's base domain + `publicPort` for the public one.
 */
export function buildDatastoreConnectionUrl(
  kind: DatastoreKind,
  creds: DatastoreCredentials,
  host: string,
  port: number
): string {
  if (kind === "postgres") {
    const user = creds.username ?? "sohwe";
    const db = creds.database ?? "sohwe";
    return `postgresql://${user}:${creds.password}@${host}:${String(port)}/${db}`;
  }
  return `redis://:${creds.password}@${host}:${String(port)}/0`;
}

// --- Phase 8: Custom domain DNS assist ---------------------------------------

/**
 * DNS providers Sohwe can write records through. Detection covers many more
 * providers (see the registry in `apps/api/src/dns/providers.ts`); this enum is
 * only the subset with an API integration and a stored credential.
 */
export const DNS_API_PROVIDERS = [
  "cloudflare",
  "digitalocean",
  "hetzner"
] as const;
export const DnsApiProviderSchema = z.enum(DNS_API_PROVIDERS);
export type DnsApiProvider = z.infer<typeof DnsApiProviderSchema>;

/** Query for `GET /api/dns/inspect`. */
export const DnsInspectQuerySchema = z.object({
  domain: DomainSchema
});
export type DnsInspectQuery = z.infer<typeof DnsInspectQuerySchema>;

/**
 * Body for `PUT /api/dns/credentials/:provider`. The token is encrypted at
 * rest and never returned; Cloudflare tokens are ~40 chars, other providers
 * may differ, so the bounds are deliberately loose.
 */
export const SetDnsCredentialSchema = z.object({
  token: z.string().trim().min(10).max(512)
});
export type SetDnsCredentialInput = z.infer<typeof SetDnsCredentialSchema>;

/** Where a domain's DNS zone is hosted, as shown in the dashboard. */
export type DnsProviderInfo = {
  id: string;
  name: string;
  /** Deep link to the provider's DNS console; may embed the zone name. */
  url: string | null;
  /** True when Sohwe can apply the record through this provider's API. */
  apiSupported: boolean;
};

/** The record a custom domain needs to route to this instance. */
export type DnsRecordSuggestion = {
  type: "A";
  name: string;
  value: string;
};

/**
 * - `verified`    the domain resolves to this instance's address
 * - `proxied`     it resolves to a reverse-proxy edge (Cloudflare's orange
 *                 cloud), so the origin behind it cannot be seen from outside.
 *                 Distinct from `mismatch`: this is a working setup, not a
 *                 misconfigured one, and must never be reported as `verified`
 * - `mismatch`    it resolves somewhere else
 * - `unresolved`  no address records exist yet
 * - `unknown`     the instance's own address could not be determined; see
 *                 `expectedIpIssue`
 */
export type DnsInspectionStatus =
  | "verified"
  | "proxied"
  | "mismatch"
  | "unresolved"
  | "unknown";

/**
 * How the instance's own public address was established.
 * - `configured`   stated outright by the operator via `SOHWE_PUBLIC_IP`
 * - `base-domain`  resolved from `SOHWE_BASE_DOMAIN` or a wildcard label
 */
export type ExpectedIpSource = "configured" | "base-domain";

/** Response of `GET /api/dns/inspect`. Contains nothing secret. */
export type DnsInspection = {
  domain: string;
  /** Zone apex the NS records were found at; null when NS lookup failed. */
  zone: string | null;
  nameservers: string[];
  /** Matched provider; null when the nameservers are not in the registry. */
  provider: DnsProviderInfo | null;
  /** IPv4 this instance's apps resolve to. Null when it could not be trusted. */
  expectedIp: string | null;
  /** How `expectedIp` was established; null when there is no `expectedIp`. */
  expectedIpSource: ExpectedIpSource | null;
  /**
   * Why `expectedIp` is null, in words fit to show an operator. Null whenever
   * `expectedIp` is set. The case that matters: the apps base domain is itself
   * behind a proxy, so resolving it yields an edge address rather than this
   * server — pointing a customer domain at that address is what produces
   * Cloudflare's "Error 1000: DNS points to prohibited IP".
   */
  expectedIpIssue: string | null;
  /** Addresses the domain currently resolves to. */
  resolvedIps: string[];
  status: DnsInspectionStatus;
  /** Suggested record; null while expectedIp is unknown. */
  record: DnsRecordSuggestion | null;
};

/** Response of `POST /api/applications/:id/domains/:domainId/dns/apply`. */
export type DnsApplyResult = {
  action: "created" | "updated";
  provider: DnsApiProvider;
  zone: string;
  record: DnsRecordSuggestion;
  /**
   * Whether the record sits behind the provider's proxy/CDN after the write.
   * Only Cloudflare has the concept; absent everywhere else.
   */
  proxied?: boolean;
};

// --- Custom domains -----------------------------------------------------------

/**
 * A hostname an application answers on. `lastStatus` is the cached result of
 * the last DNS check so a list of domains renders without one lookup per row;
 * it is a `DnsInspectionStatus`, or null before the first check.
 */
export type DomainRow = {
  id: string;
  applicationId: string;
  hostname: string;
  isPrimary: boolean;
  lastStatus: DnsInspectionStatus | null;
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
};

/**
 * Response of `POST /api/applications/:id/domains/:domainId/verify`: the
 * freshly re-checked domain row plus the full inspection behind it.
 */
export type DomainVerifyResult = {
  domain: DomainRow;
  dns: DnsInspection;
};
