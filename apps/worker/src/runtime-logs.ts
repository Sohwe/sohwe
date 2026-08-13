import { PassThrough } from "node:stream";

// Runtime log tailing (Phase 4), extracted from the worker entrypoint so the
// line splitting, tail replacement, and startup-recovery scan are testable
// against a Docker double. Each app gets at most one follow-mode `docker logs`
// stream whose demuxed lines are published to the app's Redis log channel.

type TailStream = NodeJS.ReadableStream & { destroy?(): void };

/** The slice of a dockerode Container the tail touches. */
export type LogTailContainer = {
  id: string;
  logs(opts: {
    follow: true;
    stdout: true;
    stderr: true;
    timestamps: false;
    since: number;
  }): Promise<unknown>;
};

/** The slice of dockerode the manager touches; a test double implements this. */
export type LogTailDocker = {
  listContainers(opts: {
    filters: { label: string[] };
  }): Promise<{ Id: string; Labels?: Record<string, string> }[]>;
  getContainer(id: string): LogTailContainer;
};

export function createRuntimeLogTailManager(deps: {
  docker: LogTailDocker;
  publish: (appId: string, line: string) => void;
  /**
   * Docker's 8-byte stdout/stderr demultiplexer (`docker.modem.demuxStream`).
   * When absent — or when it throws, as it can for TTY streams — the manager
   * falls back to reading the stream raw.
   */
  demux?: (
    stream: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream
  ) => void;
  now?: () => number;
}): {
  start(appId: string, container: LogTailContainer, since?: number): Promise<void>;
  stop(appId: string): void;
  /** Re-attach tails for already-running managed app containers (startup recovery). */
  startForRunning(): Promise<void>;
  stopAll(): void;
  size(): number;
} {
  const now = deps.now ?? Date.now;
  const tails = new Map<string, { containerId: string; stream: TailStream }>();

  function stop(appId: string): void {
    const tail = tails.get(appId);
    if (!tail) return;
    tails.delete(appId);
    tail.stream.destroy?.();
  }

  async function start(
    appId: string,
    container: LogTailContainer,
    since = Math.floor(now() / 1000)
  ): Promise<void> {
    stop(appId);

    let stream: TailStream;
    try {
      stream = (await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: false,
        since
      })) as TailStream;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.publish(appId, `[sohwe] Failed to attach runtime logs: ${msg}`);
      return;
    }

    tails.set(appId, { containerId: container.id, stream });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) deps.publish(appId, line);
      }
    };

    const onEnd = () => {
      if (buffer.length > 0) {
        deps.publish(appId, buffer);
        buffer = "";
      }
      // Only clear the registration if it is still ours: a replacement tail
      // for the same app may already have been started.
      const current = tails.get(appId);
      if (current?.containerId === container.id) {
        tails.delete(appId);
      }
      stdout.destroy();
      stderr.destroy();
    };

    stdout.on("data", onData);
    stderr.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onEnd);
    stream.on("error", (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      deps.publish(appId, `[sohwe] Runtime log stream ended: ${msg}`);
      onEnd();
    });

    try {
      if (!deps.demux) throw new Error("no demuxer");
      deps.demux(stream, stdout, stderr);
    } catch {
      stream.on("data", onData);
    }
  }

  async function startForRunning(): Promise<void> {
    const containers = await deps.docker.listContainers({
      filters: { label: ["sohwe.managed=true"] }
    });
    for (const c of containers) {
      // Datastores are sohwe.managed but have no sohwe.app label; skipping
      // them keeps datastore output out of per-app runtime logs.
      const appId = c.Labels?.["sohwe.app"];
      if (!appId) continue;
      await start(appId, deps.docker.getContainer(c.Id));
    }
  }

  return {
    start,
    stop,
    startForRunning,
    stopAll() {
      for (const appId of [...tails.keys()]) stop(appId);
    },
    size() {
      return tails.size;
    }
  };
}
