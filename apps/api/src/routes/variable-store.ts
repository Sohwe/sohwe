import { decryptJson, encryptJson, maskedPreview } from "@sohwe/crypto";

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
