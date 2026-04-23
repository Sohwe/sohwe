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
  domain: OptionalDomain
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
      .optional()
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