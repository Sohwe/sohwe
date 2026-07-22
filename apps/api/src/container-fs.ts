import { PassThrough, type Readable, type Writable } from "node:stream";
import type Docker from "dockerode";
import { extract as tarExtract } from "tar-stream";

export class FsError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "FsError";
  }
}

const LIST_SCRIPT =
  'p="$SOHWE_PATH"; cd "$p" 2>/dev/null || exit 2; ls -1A 2>/dev/null | while IFS= read -r n; do [ -z "$n" ] && continue; full="$p/$n"; if [ -L "$full" ]; then printf "l\\t%s\\n" "$n"; elif [ -d "$full" ]; then printf "d\\t%s\\n" "$n"; else printf "f\\t%s\\n" "$n"; fi; done';

const STAT_SCRIPT =
  'p="$SOHWE_PATH"; if [ ! -e "$p" ]; then exit 3; elif [ -d "$p" ]; then printf "directory\\n"; else printf "file\\n"; fi';

const MAX_FILE_BYTES = 512 * 1024;

export function normalizeContainerPath(raw: string): string {
  const p = raw.trim();
  if (!p.startsWith("/")) {
    throw new FsError(400, "Path must be absolute (start with /)");
  }
  if (p.length > 4096) {
    throw new FsError(400, "Path too long");
  }
  const parts = p.split("/").filter((s) => s.length > 0);
  for (const part of parts) {
    if (part === "..") {
      throw new FsError(400, "Invalid path");
    }
  }
  if (parts.length === 0) return "/";
  return `/${parts.join("/")}`;
}

export async function getRunningAppContainer(
  docker: Docker,
  appId: string
): Promise<Docker.Container | null> {
  const list = await docker.listContainers({
    filters: {
      label: [`sohwe.app=${appId}`],
      status: ["running"]
    }
  });
  if (!list.length) return null;
  const c = list[0];
  if (!c) return null;
  return docker.getContainer(c.Id);
}

type ModemDemux = {
  demuxStream: (
    stream: Readable,
    out: Writable,
    err: Writable
  ) => void;
};

/**
 * Run `sh -c script` in the container with SOHWE_PATH set.
 * Uses Tty: false and demultiplexes stdout/stderr (Docker’s 8-byte framing).
 * Raw Tty mode was mixing framing bytes into UTF-8 and breaking simple scripts.
 */
async function execInContainer(
  container: Docker.Container,
  envPath: string,
  script: string
): Promise<{ out: string; err: string; exit: number }> {
  const exec = await container.exec({
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Env: [`SOHWE_PATH=${envPath}`],
    Cmd: ["sh", "-c", script]
  });
  const stream = (await exec.start({
    hijack: true,
    stdin: false
  })) as Readable;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  stdout.on("data", (b: Buffer) => outChunks.push(b));
  stderr.on("data", (b: Buffer) => errChunks.push(b));
  (container as unknown as { modem: ModemDemux }).modem.demuxStream(
    stream,
    stdout,
    stderr
  );
  await new Promise<void>((resolve, reject) => {
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  const info = await exec.inspect();
  return {
    out: Buffer.concat(outChunks).toString("utf8"),
    err: Buffer.concat(errChunks).toString("utf8"),
    exit: info.ExitCode ?? -1
  };
}

export type FsListEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
};

export async function listContainerPath(
  container: Docker.Container,
  path: string
): Promise<FsListEntry[]> {
  const { out, err, exit } = await execInContainer(container, path, LIST_SCRIPT);
  if (exit === 2) {
    throw new FsError(404, "Path not found or not a directory");
  }
  if (exit !== 0) {
    throw new FsError(
      500,
      (out + err).trim() || `Listing failed (exit ${String(exit)})`
    );
  }
  const lines = out.split("\n").map((l) => l.replace(/\r$/, ""));
  const entries: FsListEntry[] = [];
  for (const line of lines) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const kindChar = line.slice(0, tab);
    const name = line.slice(tab + 1);
    if (!name) continue;
    const kind: FsListEntry["kind"] =
      kindChar === "d" ? "dir" : kindChar === "l" ? "symlink" : "file";
    entries.push({ name, kind });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === "dir") return -1;
      if (b.kind === "dir") return 1;
    }
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function parseStatOutput(raw: string, stderr: string): "file" | "directory" {
  const combined = (raw + stderr)
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ""))
    // The ESC control character below is intentional: container `stat` output
    // can carry ANSI colour codes, which we strip before matching.
    // eslint-disable-next-line no-control-regex
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""))
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  const t = combined.toLowerCase();
  if (t === "directory") return "directory";
  if (t === "file") return "file";
  // Fallback: first token on first line
  const words = combined.split(/\s+/).filter(Boolean);
  const w = (words[0] ?? "").toLowerCase();
  if (w === "directory" || w === "file") {
    return w;
  }
  throw new FsError(500, "Unexpected stat output");
}

export async function statContainerPath(
  container: Docker.Container,
  path: string
): Promise<"file" | "directory" | "missing"> {
  const { out, err, exit } = await execInContainer(
    container,
    path,
    STAT_SCRIPT
  );
  if (exit === 3) return "missing";
  if (exit !== 0) {
    throw new FsError(
      500,
      (out + err).trim() || `Stat failed (exit ${String(exit)})`
    );
  }
  return parseStatOutput(out, err);
}

function classifyBuffer(buf: Buffer): {
  encoding: "utf8" | "base64";
  content: string;
} {
  if (buf.includes(0)) {
    return { encoding: "base64", content: buf.toString("base64") };
  }
  return { encoding: "utf8", content: buf.toString("utf8") };
}

export async function readContainerFile(
  container: Docker.Container,
  path: string
): Promise<{
  content: string;
  encoding: "utf8" | "base64";
  truncated: boolean;
  size: number;
}> {
  const kind = await statContainerPath(container, path);
  if (kind === "missing") {
    throw new FsError(404, "Path not found");
  }
  if (kind === "directory") {
    throw new FsError(400, "Path is a directory");
  }

  const stream = (await container.getArchive({
    path
  } as { path: string })) as Readable;
  const extractor = tarExtract();

  const readPromise = new Promise<{
    buf: Buffer;
    headerSize: number;
    truncated: boolean;
  }>((resolve, reject) => {
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const ok = (v: {
      buf: Buffer;
      headerSize: number;
      truncated: boolean;
    }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let firstEntry = true;
    extractor.on(
      "entry",
      (header, entryStream: NodeJS.ReadableStream, next) => {
        if (!firstEntry) {
          entryStream.resume();
          next();
          return;
        }
        firstEntry = false;

        if (header.type === "directory") {
          entryStream.resume();
          next();
          fail(new FsError(400, "Path is a directory"));
          return;
        }

        const headerSize = Number(header.size) || 0;
        const chunks: Buffer[] = [];
        let buffered = 0;
        let truncated = false;

        entryStream.on("data", (c: Buffer) => {
          if (buffered < MAX_FILE_BYTES) {
            const room = MAX_FILE_BYTES - buffered;
            const take = Math.min(room, c.length);
            chunks.push(take === c.length ? c : c.subarray(0, take));
            buffered += take;
          } else {
            truncated = true;
          }
        });
        entryStream.on("end", () => {
          if (headerSize > MAX_FILE_BYTES) truncated = true;
          ok({ buf: Buffer.concat(chunks), headerSize, truncated });
          next();
        });
        entryStream.on("error", (e) => {
          fail(e);
          next();
        });
      }
    );

    extractor.on("error", (e) => fail(e));
    extractor.on("finish", () => {
      if (!settled) {
        fail(new FsError(500, "Unexpected empty archive from container"));
      }
    });
    stream.on("error", (e) => fail(e));
    stream.pipe(extractor);
  });

  try {
    const { buf, headerSize, truncated } = await readPromise;
    const { encoding, content } = classifyBuffer(buf);
    return {
      content,
      encoding,
      truncated,
      size: headerSize
    };
  } finally {
    stream.destroy();
  }
}
