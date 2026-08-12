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
const DomainSchema = z
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
 */
export const UpdateApplicationSchema = z
  .object({
    name: z.string().min(1).optional(),
    gitBranch: z.string().min(1).optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    buildMode: z.enum(["auto", "dockerfile", "nixpacks"]).optional(),
    buildCmd: z.string().nullable().optional(),
    startCmd: z.string().nullable().optional(),
    domain: OptionalDomain.or(z.null()),
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