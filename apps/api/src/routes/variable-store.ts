import { decryptJson, encryptJson, maskedPreview } from "@sohwe/crypto";
import type {
  VariableEntry,
  VariableRescope,
  VariableScope
} from "@sohwe/types";

// Applications carry two independent `KEY -> value` maps, both AES-encrypted in
// a `Bytes` column: runtime env vars and build variables. The routes over them
// differ only in path, column, and audit action, so the shaping and merging
// logic lives here rather than being written twice and drifting.

/** Decrypt a variable blob. An absent or empty column means "no variables". */
export function readVarBlob(
  enc: Buffer | Uint8Array | null | undefined
): Record<string, string> {
  if (!enc || enc.length === 0) return {};
  return decryptJson(Buffer.isBuffer(enc) ? enc : Buffer.from(enc));
}

/**
 * Encode a map back to ciphertext, collapsing the empty map to `null` so an
 * app with no variables stores nothing rather than an encrypted `{}`.
 */
export function encodeVarBlob(vars: Record<string, string>): Buffer | null {
  return Object.keys(vars).length === 0 ? null : encryptJson(vars);
}

/** Key-sorted listing with values masked — safe for the default GET. */
export function maskedListing(map: Record<string, string>) {
  return {
    keys: Object.keys(map).sort(),
    items: Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, preview: maskedPreview(value) }))
  };
}

/** Key-sorted listing with plaintext values — only for `?reveal=true`. */
export function revealedListing(map: Record<string, string>) {
  return {
    keys: Object.keys(map).sort(),
    items: Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value }))
  };
}

/** Apply a PATCH body to a copy of `map`; `unset` wins over `set`. */
export function applyVarPatch(
  map: Record<string, string>,
  set: Record<string, string> | undefined,
  unset: string[] | undefined
): Record<string, string> {
  const next = { ...map };
  if (set) for (const [k, v] of Object.entries(set)) next[k] = v;
  if (unset) for (const k of unset) delete next[k];
  return next;
}


/*
 * One list, two maps.
 *
 * The unified `/variables` surface presents an application's variables the way
 * Railway does — a single list where each entry says whether it reaches the
 * build, the container, or both. Underneath, storage is unchanged: two
 * independent encrypted columns. A key's scope is *derived* from which maps
 * hold it, so there is no third source of truth to migrate, no ciphertext to
 * rewrite, and the deploy path keeps reading exactly the columns it always did.
 *
 * The cost of deriving it is that the two maps can disagree about a value for
 * the same key — reachable through the older per-map routes, or through a
 * restored bundle. That is reported rather than silently resolved.
 */

export type ScopedVariable = {
  key: string;
  scope: VariableScope;
  /** The runtime value, or the build value for a build-only key. */
  value: string;
  /**
   * Set when the two maps hold the same key with *different* values. The
   * unified list cannot show one value for such a key, so it carries the
   * runtime one and flags the disagreement; writing the key resolves it.
   */
  buildValue?: string;
};

/** Merge the two maps into one key-sorted list with a derived scope. */
export function mergeScoped(
  env: Record<string, string>,
  build: Record<string, string>
): ScopedVariable[] {
  const keys = [...new Set([...Object.keys(env), ...Object.keys(build)])].sort(
    (a, b) => a.localeCompare(b)
  );
  return keys.map((key) => {
    const inEnv = Object.hasOwn(env, key);
    const inBuild = Object.hasOwn(build, key);
    if (inEnv && inBuild) {
      const value = env[key]!;
      const buildValue = build[key]!;
      return value === buildValue
        ? { key, scope: "both" as const, value }
        : { key, scope: "both" as const, value, buildValue };
    }
    if (inEnv) return { key, scope: "runtime" as const, value: env[key]! };
    return { key, scope: "build" as const, value: build[key]! };
  });
}

/** Split a unified list back into the two maps the columns store. */
export function splitScoped(entries: readonly VariableEntry[]): {
  env: Record<string, string>;
  build: Record<string, string>;
} {
  const env: Record<string, string> = {};
  const build: Record<string, string> = {};
  for (const { key, value, scope } of entries) {
    if (scope === "runtime" || scope === "both") env[key] = value;
    if (scope === "build" || scope === "both") build[key] = value;
  }
  return { env, build };
}

/**
 * Apply a unified PATCH to both maps at once. `unset` removes a key from both
 * maps regardless of its scope, and wins over `set`; a `set` entry rewrites the
 * key's scope, so moving a variable from `both` to `runtime` also deletes it
 * from the build map.
 */
export function applyScopedPatch(
  env: Record<string, string>,
  build: Record<string, string>,
  set: readonly VariableEntry[] | undefined,
  unset: readonly string[] | undefined,
  rescope: readonly VariableRescope[] | undefined = undefined
): { env: Record<string, string>; build: Record<string, string> } {
  const nextEnv = { ...env };
  const nextBuild = { ...build };
  const place = (key: string, value: string, scope: VariableScope) => {
    if (scope === "runtime" || scope === "both") nextEnv[key] = value;
    else delete nextEnv[key];
    if (scope === "build" || scope === "both") nextBuild[key] = value;
    else delete nextBuild[key];
  };
  for (const { key, value, scope } of set ?? []) place(key, value, scope);
  // A rescope keeps whatever value the key already has. For a key the two maps
  // disagree about, the runtime value is the one that survives — the same one
  // the unified listing shows, so the result matches what the user was looking
  // at when they changed the scope.
  for (const { key, scope } of rescope ?? []) {
    const current = nextEnv[key] ?? nextBuild[key];
    if (current === undefined) continue;
    place(key, current, scope);
  }
  for (const key of unset ?? []) {
    delete nextEnv[key];
    delete nextBuild[key];
  }
  return { env: nextEnv, build: nextBuild };
}

/** Keys named by a rescope that the application does not have. */
export function unknownRescopeKeys(
  env: Record<string, string>,
  build: Record<string, string>,
  rescope: readonly VariableRescope[] | undefined
): string[] {
  return (rescope ?? [])
    .map((r) => r.key)
    .filter((k) => !Object.hasOwn(env, k) && !Object.hasOwn(build, k));
}

/** Unified listing with values masked — safe for the default GET. */
export function maskedScopedListing(vars: readonly ScopedVariable[]) {
  return {
    keys: vars.map((v) => v.key),
    items: vars.map((v) => ({
      key: v.key,
      scope: v.scope,
      preview: maskedPreview(v.value),
      ...(v.buildValue === undefined
        ? {}
        : { conflict: true, buildPreview: maskedPreview(v.buildValue) })
    }))
  };
}

/** Unified listing with plaintext values — only for `?reveal=true`. */
export function revealedScopedListing(vars: readonly ScopedVariable[]) {
  return {
    keys: vars.map((v) => v.key),
    items: vars.map((v) => ({
      key: v.key,
      scope: v.scope,
      value: v.value,
      ...(v.buildValue === undefined
        ? {}
        : { conflict: true, buildValue: v.buildValue })
    }))
  };
}
