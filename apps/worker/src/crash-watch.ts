// Crash detection + webhook alert payloads (Phase 4), extracted from the
// worker entrypoint so event classification and the reconnect loop are
// testable against a Docker double.
//
// We watch Docker `die`/`oom` events for managed containers. On a crash the
// caller (index.ts) marks the app `crashed` and POSTs a webhook to each enabled
// per-app destination. Alert payloads carry only non-sensitive metadata (app
// name/slug, event, exit code, container id, timestamp) — never env var values
// or other secrets.

export type DockerEvent = {
  Type?: string;
  Action?: string;
  status?: string;
  id?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
};

export type CrashInfo = {
  appId: string;
  event: "crashed" | "out of memory";
  exitCode: string;
  containerId: string;
};

/**
 * Decide whether a raw Docker event is a crash worth acting on. Pure: the
 * whole die/oom/exit-code/label policy lives here.
 */
export function classifyCrashEvent(ev: DockerEvent): CrashInfo | null {
  if (ev.Type && ev.Type !== "container") return null;
  const action = ev.Action ?? ev.status ?? "";
  const isOom = action === "oom";
  const isDie = action === "die";
  if (!isOom && !isDie) return null;

  const attrs = ev.Actor?.Attributes ?? {};
  const appId = attrs["sohwe.app"];
  if (!appId) return null;

  const exitCode = attrs.exitCode ?? "";
  // A clean stop (exit 0) is not a crash; an OOM kill always is.
  if (isDie && (exitCode === "0" || exitCode === "")) return null;

  return {
    appId,
    event: isOom ? "out of memory" : "crashed",
    exitCode,
    containerId: ev.Actor?.ID ?? ev.id ?? ""
  };
}

export function buildAlertPayload(
  type: string,
  info: {
    appName: string;
    appSlug: string;
    event: string;
    exitCode: string;
    containerId: string;
    timeIso: string;
  }
): unknown {
  const title = `🔴 Sohwe: app "${info.appName}" ${info.event}`;
  const detail =
    `App: ${info.appName} (${info.appSlug})\n` +
    `Event: ${info.event}\n` +
    `Exit code: ${info.exitCode}\n` +
    `Container: ${info.containerId.slice(0, 12)}\n` +
    `Time: ${info.timeIso}`;
  if (type === "slack") {
    return { text: `${title}\n${detail}` };
  }
  if (type === "discord") {
    return { content: `**${title}**\n${detail}` };
  }
  // generic
  return {
    type: "sohwe.crash",
    app: { name: info.appName, slug: info.appSlug },
    event: info.event,
    exitCode: info.exitCode,
    containerId: info.containerId,
    time: info.timeIso
  };
}

/** The slice of dockerode the watcher touches; a test double implements this. */
export type EventsDocker = {
  getEvents(opts: {
    // "container" is literal so the object stays assignable to dockerode's
    // GetEventsOptions when index.ts forwards it.
    filters: { type: "container"[]; event: string[]; label: string[] };
  }): Promise<NodeJS.ReadableStream>;
};

export function createDockerEventWatcher(deps: {
  docker: EventsDocker;
  onCrash: (crash: CrashInfo) => Promise<void>;
  reconnectDelayMs?: number;
  onError?: (msg: string, err: unknown) => void;
}): {
  start(): Promise<void>;
  stop(): void;
} {
  const reconnectDelayMs = deps.reconnectDelayMs ?? 1000;
  const onError = deps.onError ?? ((msg, err) => console.error(msg, err));
  let stream: (NodeJS.ReadableStream & { destroy?(): void }) | null = null;
  let stopping = false;

  async function start(): Promise<void> {
    if (stopping) return;
    try {
      stream = (await deps.docker.getEvents({
        filters: {
          type: ["container"],
          event: ["die", "oom"],
          label: ["sohwe.managed=true"]
        }
      })) as NodeJS.ReadableStream & { destroy?(): void };
    } catch (e) {
      onError("Failed to subscribe to Docker events", e);
      return;
    }

    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const crash = classifyCrashEvent(JSON.parse(trimmed) as DockerEvent);
          if (crash) void deps.onCrash(crash).catch(() => {});
        } catch {
          // ignore malformed line
        }
      }
    };

    // A dying stream can fire several of end/close/error; without the guard
    // each would schedule its own resubscribe and the watcher would fan out
    // one extra events stream per disconnect (a leak the inline original had).
    let reconnectScheduled = false;
    const reconnect = () => {
      if (reconnectScheduled) return;
      reconnectScheduled = true;
      stream = null;
      if (stopping) return;
      setTimeout(() => {
        void start();
      }, reconnectDelayMs);
    };

    stream.on("data", onData);
    stream.on("end", reconnect);
    stream.on("close", reconnect);
    stream.on("error", (e) => {
      onError("Docker events stream error", e);
      reconnect();
    });
  }

  return {
    start,
    stop() {
      stopping = true;
      stream?.destroy?.();
      stream = null;
    }
  };
}
