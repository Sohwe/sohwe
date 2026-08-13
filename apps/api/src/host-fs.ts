import { open, readdir, realpath, stat } from "node:fs/promises";
import {
  FsError,
  normalizeContainerPath,
  type FsListEntry
} from "./container-fs";

// Read-only browsing of the *instance host* filesystem (Phase 6 optional item),
// as opposed to `container-fs.ts`, which browses a running app container.
//
// The security model is different from the container browser: a container is
// already scoped to one app, but the host is everything, so access is gated by
// an explicit operator-set allowlist (`SOHWE_HOST_FS_ALLOWLIST`). No allowlist
// means the feature is off. Two invariants:
//
// 1. Every path is resolved through `realpath` and re-checked against the
//    realpath'd roots, so a symlink inside an allowed root cannot escape it.
// 2. In production the API runs in a container, so "the host" is whatever the
//    operator bind-mounts in (the prod compose mounts /etc/sohwe read-only).
//    An allowlisted path that is not mounted simply reads as not found.

const MAX_FILE_BYTES = 512 * 1024;

/**
 * Parse `SOHWE_HOST_FS_ALLOWLIST`: comma-separated absolute paths. Invalid
 * entries push onto `errors` (the `loadApiConfig` fail-fast pattern) rather
 * than being silently dropped — a typo'd allowlist should refuse to boot, not
 * quietly expose nothing or the wrong thing.
 */
export function parseHostFsAllowlist(
  raw: string | undefined,
  errors: string[]
): string[] {
  if (!raw || raw.trim().length === 0) return [];
  const roots: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    try {
      roots.push(normalizeContainerPath(entry));
    } catch (e) {
      errors.push(
        `SOHWE_HOST_FS_ALLOWLIST entry "${entry}" is invalid: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }
  return [...new Set(roots)];
}

/** Is `path` equal to or beneath one of the normalized `roots`? */
export function isPathAllowed(path: string, roots: string[]): boolean {
  return roots.some(
    (root) => path === root || path.startsWith(root === "/" ? "/" : `${root}/`)
  );
}

function toFsError(e: unknown, notFound: string): FsError {
  const code =
    e && typeof e === "object" && "code" in e ? String(e.code) : "";
  if (code === "ENOENT" || code === "ENOTDIR") return new FsError(404, notFound);
  if (code === "EACCES" || code === "EPERM") {
    return new FsError(403, "Permission denied");
  }
  return new FsError(500, e instanceof Error ? e.message : String(e));
}

/**
 * Normalize a requested path, verify it sits under an allowed root, and
 * resolve symlinks — rejecting when the resolved target escapes every root.
 * Returns the real path all reads should operate on.
 */
export async function resolveHostPath(
  rawPath: string,
  roots: string[]
): Promise<{ path: string; realPath: string }> {
  const path = normalizeContainerPath(rawPath);
  if (!isPathAllowed(path, roots)) {
    throw new FsError(403, "Path is outside the allowed roots");
  }

  let real: string;
  try {
    real = await realpath(path);
  } catch (e) {
    throw toFsError(e, "Path not found");
  }

  // Roots are realpath'd too: on hosts where a root is itself behind a symlink
  // (macOS /tmp, /var), every resolved child would otherwise fail the check.
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue; // root doesn't exist (e.g. not mounted); it can't authorize anything
    }
    if (isPathAllowed(real, [realRoot])) return { path, realPath: real };
  }
  throw new FsError(403, "Path resolves outside the allowed roots");
}

export async function listHostPath(realPath: string): Promise<FsListEntry[]> {
  let dirents;
  try {
    dirents = await readdir(realPath, { withFileTypes: true });
  } catch (e) {
    throw toFsError(e, "Path not found or not a directory");
  }
  const entries: FsListEntry[] = dirents.map((d) => ({
    name: d.name,
    kind: d.isSymbolicLink() ? "symlink" : d.isDirectory() ? "dir" : "file"
  }));
  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === "dir") return -1;
      if (b.kind === "dir") return 1;
    }
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export async function readHostFile(realPath: string): Promise<{
  content: string;
  encoding: "utf8" | "base64";
  truncated: boolean;
  size: number;
}> {
  let st;
  try {
    st = await stat(realPath);
  } catch (e) {
    throw toFsError(e, "Path not found");
  }
  if (st.isDirectory()) throw new FsError(400, "Path is a directory");

  let handle;
  try {
    handle = await open(realPath, "r");
  } catch (e) {
    throw toFsError(e, "Path not found");
  }
  try {
    const buf = Buffer.alloc(MAX_FILE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAX_FILE_BYTES, 0);
    const data = buf.subarray(0, bytesRead);
    const encoding = data.includes(0) ? "base64" : "utf8";
    return {
      content: data.toString(encoding),
      encoding,
      truncated: st.size > bytesRead,
      size: st.size
    };
  } finally {
    await handle.close();
  }
}
