import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { decryptJson } from "@sohwe/crypto";
import type { S3DestConfig } from "@sohwe/types";

/** Suffix every bundle filename carries; used to filter destination listings. */
export const BUNDLE_FILE_SUFFIX = ".sohwe.json";

export type ResolvedLocalDestination = {
  kind: "local";
  path: string;
};

export type ResolvedS3Destination = {
  kind: "s3";
  bucket: string;
  region: string;
  endpoint?: string;
  prefix?: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
};

export type ResolvedDestination =
  | ResolvedLocalDestination
  | ResolvedS3Destination;

/** A `BackupDestination` row, narrowed to the fields storage needs. */
export type DestinationRow = {
  kind: string;
  config: unknown;
  secretEncrypted: Buffer | Uint8Array | null;
};

/**
 * Turn a stored destination row into a usable storage target, decrypting S3
 * credentials from `secretEncrypted` with the instance key. Throws on a
 * malformed/unknown destination so callers can surface a clear error.
 */
export function resolveDestination(row: DestinationRow): ResolvedDestination {
  if (row.kind === "local") {
    const cfg = row.config as { path?: unknown } | null;
    const path = typeof cfg?.path === "string" ? cfg.path : null;
    if (!path) throw new Error("Local destination is missing a path");
    return { kind: "local", path };
  }
  if (row.kind === "s3") {
    const cfg = (row.config ?? {}) as Partial<S3DestConfig>;
    if (typeof cfg.bucket !== "string" || typeof cfg.region !== "string") {
      throw new Error("S3 destination config is missing bucket or region");
    }
    if (!row.secretEncrypted || row.secretEncrypted.length === 0) {
      throw new Error("S3 destination is missing stored credentials");
    }
    const buf = Buffer.isBuffer(row.secretEncrypted)
      ? row.secretEncrypted
      : Buffer.from(row.secretEncrypted);
    const creds = decryptJson(buf);
    const accessKeyId = creds.accessKeyId;
    const secretAccessKey = creds.secretAccessKey;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("Stored S3 credentials are incomplete");
    }
    return {
      kind: "s3",
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: typeof cfg.endpoint === "string" ? cfg.endpoint : undefined,
      prefix: typeof cfg.prefix === "string" ? cfg.prefix : undefined,
      forcePathStyle: cfg.forcePathStyle === true,
      accessKeyId,
      secretAccessKey
    };
  }
  throw new Error(`Unsupported destination kind: ${row.kind}`);
}

/** Normalize an S3 prefix to `""` or `"<prefix>/"` (no leading slash). */
function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  const trimmed = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed.length > 0 ? `${trimmed}/` : "";
}

function s3KeyFor(dest: ResolvedS3Destination, filename: string): string {
  return `${normalizePrefix(dest.prefix)}${filename}`;
}

function makeS3Client(dest: ResolvedS3Destination): S3Client {
  return new S3Client({
    region: dest.region,
    endpoint: dest.endpoint,
    forcePathStyle: dest.forcePathStyle,
    credentials: {
      accessKeyId: dest.accessKeyId,
      secretAccessKey: dest.secretAccessKey
    }
  });
}

/** Write a bundle's JSON to the destination under `filename`. */
export async function writeBundle(
  dest: ResolvedDestination,
  filename: string,
  json: string
): Promise<void> {
  if (dest.kind === "local") {
    await mkdir(dest.path, { recursive: true });
    await writeFile(join(dest.path, filename), json, "utf8");
    return;
  }
  const client = makeS3Client(dest);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: dest.bucket,
        Key: s3KeyFor(dest, filename),
        Body: json,
        ContentType: "application/json"
      })
    );
  } finally {
    client.destroy();
  }
}

/** Delete a previously written bundle; missing files are ignored. */
export async function deleteBundle(
  dest: ResolvedDestination,
  filename: string
): Promise<void> {
  if (dest.kind === "local") {
    await rm(join(dest.path, filename), { force: true });
    return;
  }
  const client = makeS3Client(dest);
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: dest.bucket,
        Key: s3KeyFor(dest, filename)
      })
    );
  } finally {
    client.destroy();
  }
}

/**
 * List bundle filenames present at the destination (best-effort; used for
 * surfacing/cleanup). Returns bare filenames, prefix stripped for S3.
 */
export async function listBundleFilenames(
  dest: ResolvedDestination
): Promise<string[]> {
  if (dest.kind === "local") {
    let entries: string[];
    try {
      entries = await readdir(dest.path);
    } catch {
      return [];
    }
    return entries.filter((f) => f.endsWith(BUNDLE_FILE_SUFFIX));
  }
  const client = makeS3Client(dest);
  const prefix = normalizePrefix(dest.prefix);
  const out: string[] = [];
  try {
    let token: string | undefined;
    do {
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: dest.bucket,
          Prefix: prefix,
          ContinuationToken: token
        })
      );
      for (const obj of res.Contents ?? []) {
        const key = obj.Key;
        if (!key || !key.endsWith(BUNDLE_FILE_SUFFIX)) continue;
        out.push(key.slice(prefix.length));
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  } finally {
    client.destroy();
  }
  return out;
}

/** Human-readable target for logs/UI (never includes secrets). */
export function describeDestination(dest: ResolvedDestination): string {
  if (dest.kind === "local") return `local:${dest.path}`;
  return `s3:${dest.bucket}/${normalizePrefix(dest.prefix)}`;
}
