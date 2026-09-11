import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";

export const MAX_SERVICE_LOG_LINE_BYTES = 64 * 1024;

export type ServiceLogMeta = {
  projectId: string;
  serviceId: string;
  releaseId: string;
  serviceDeploymentId: string;
  containerId: string;
  restartNumber?: number;
};

export type ServiceLogEvent = ServiceLogMeta & {
  id?: string;
  stream: "stdout" | "stderr" | "system";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  containerTimestamp: Date | null;
  containerTimestampRaw: string | null;
  eventKey: string | null;
};

type LogContainer = {
  id: string;
  logs(opts: {
    follow: true;
    stdout: true;
    stderr: true;
    timestamps: true;
    since: number;
  }): Promise<unknown>;
};

function redact(message: string, secrets: string[]): string {
  let clean = message;
  for (const secret of secrets) {
    if (secret) clean = clean.split(secret).join("•••");
  }
  return clean;
}

/** Docker prefixes timestamped log lines with RFC3339Nano and one space. */
export function parseTimestampedLogLine(raw: string): {
  message: string;
  containerTimestamp: Date | null;
  containerTimestampRaw: string | null;
} {
  const space = raw.indexOf(" ");
  if (space <= 0) {
    return { message: raw, containerTimestamp: null, containerTimestampRaw: null };
  }
  const candidate = raw.slice(0, space);
  const time = new Date(candidate);
  if (Number.isNaN(time.getTime())) {
    return { message: raw, containerTimestamp: null, containerTimestampRaw: null };
  }
  return {
    message: raw.slice(space + 1),
    containerTimestamp: time,
    containerTimestampRaw: candidate
  };
}

/** Bound one event without splitting a UTF-8 sequence in the persisted text. */
export function boundLogMessage(message: string): string {
  const bytes = Buffer.from(message);
  if (bytes.length <= MAX_SERVICE_LOG_LINE_BYTES) return message;
  const suffix = "… [truncated by Sohwe]";
  const room = MAX_SERVICE_LOG_LINE_BYTES - Buffer.byteLength(suffix);
  return `${bytes.subarray(0, room).toString("utf8").replace(/\uFFFD$/, "")}${suffix}`;
}

export function inferLogLevel(message: string): ServiceLogEvent["level"] {
  if (/\b(fatal|panic|error|exception)\b/i.test(message)) return "error";
  if (/\bwarn(?:ing)?\b/i.test(message)) return "warn";
  if (/\b(debug|trace)\b/i.test(message)) return "debug";
  return "info";
}

/**
 * Per-container log tails for project services. stdout/stderr are demuxed and
 * persisted with service/release/container identity before live publication.
 */
export function createServiceLogManager(deps: {
  /** Return false when this event was already persisted during recovery. */
  persist: (event: ServiceLogEvent) => Promise<{ id: string } | boolean | void>;
  publish: (event: ServiceLogEvent) => Promise<unknown> | unknown;
  demux?: (
    stream: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream
  ) => void;
}): {
  start(meta: ServiceLogMeta, container: LogContainer, secrets?: string[], since?: number): Promise<void>;
  wait(serviceDeploymentId: string): Promise<void>;
  stop(serviceDeploymentId: string): void;
  stopAll(): void;
} {
  const tails = new Map<
    string,
    {
      stream: NodeJS.ReadableStream & { destroy?(): void };
      done: Promise<void>;
      resolveDone: () => void;
    }
  >();

  function stop(id: string): void {
    const tail = tails.get(id);
    if (!tail) return;
    tail.stream.destroy?.();
    tail.resolveDone();
    tails.delete(id);
  }

  async function start(
    meta: ServiceLogMeta,
    container: LogContainer,
    secrets: string[] = [],
    since = 0
  ): Promise<void> {
    stop(meta.serviceDeploymentId);
    const stream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: true,
      since
    })) as NodeJS.ReadableStream & { destroy?(): void };

    let resolveDone = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    tails.set(meta.serviceDeploymentId, { stream, done, resolveDone });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let pending = Promise.resolve();
    const buffers = { stdout: "", stderr: "" };

    const emit = (source: "stdout" | "stderr", raw: string) => {
      const parsed = parseTimestampedLogLine(raw);
      const message = boundLogMessage(redact(parsed.message, secrets));
      const event: ServiceLogEvent = {
        ...meta,
        restartNumber: meta.restartNumber ?? 0,
        stream: source,
        level: inferLogLevel(message),
        message,
        containerTimestamp: parsed.containerTimestamp,
        containerTimestampRaw: parsed.containerTimestampRaw,
        eventKey: parsed.containerTimestampRaw
          ? createHash("sha256")
              .update(
                `${meta.serviceDeploymentId}\0${meta.containerId}\0${source}\0${parsed.containerTimestampRaw}\0${message}`
              )
              .digest("hex")
          : null
      };
      // Preserve stream order and make persistence the handoff boundary: an
      // SSE reconnect can query this row even if it missed the publication.
      pending = pending.catch(() => {}).then(async () => {
        const inserted = await deps.persist(event);
        if (inserted && typeof inserted === "object") event.id = inserted.id;
        if (inserted !== false) {
          await Promise.resolve(deps.publish(event)).catch(() => {});
        }
      });
    };

    const onData = (source: "stdout" | "stderr", chunk: Buffer) => {
      buffers[source] += chunk.toString("utf8");
      const lines = buffers[source].split(/\r?\n/);
      buffers[source] = lines.pop() ?? "";
      for (const line of lines) emit(source, line);
      if (Buffer.byteLength(buffers[source]) > MAX_SERVICE_LOG_LINE_BYTES) {
        emit(source, buffers[source]);
        buffers[source] = "";
      }
    };
    stdout.on("data", (chunk: Buffer) => onData("stdout", chunk));
    stderr.on("data", (chunk: Buffer) => onData("stderr", chunk));

    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      if (buffers.stdout) emit("stdout", buffers.stdout);
      if (buffers.stderr) emit("stderr", buffers.stderr);
      void pending.finally(() => {
        const current = tails.get(meta.serviceDeploymentId);
        if (current?.stream === stream) tails.delete(meta.serviceDeploymentId);
        resolveDone();
      });
    };
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);

    try {
      if (!deps.demux) throw new Error("no demuxer");
      deps.demux(stream, stdout, stderr);
    } catch {
      stream.on("data", (chunk: Buffer) => onData("stdout", chunk));
    }
  }

  return {
    start,
    async wait(id) {
      await tails.get(id)?.done;
    },
    stop,
    stopAll() {
      for (const id of [...tails.keys()]) stop(id);
    }
  };
}
