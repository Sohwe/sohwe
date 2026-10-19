import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { useProject } from "@/lib/projects";
import type { ProjectRow } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogPane } from "@/components/apps/LogPane";
import { mergeProjectLogs, type ProjectLog } from "@/lib/project-logs";

const MAX_LINES = 5000;
type History = { logs: ProjectLog[]; hasMore: boolean };
function ProjectLogOutput({
  project,
  queryString,
  historical,
  initialHistory,
}: {
  project: ProjectRow;
  queryString: string;
  historical: boolean;
  initialHistory: History;
}) {
  const [logs, setLogs] = useState<ProjectLog[]>(initialHistory.logs);
  const [live, setLive] = useState(!historical);
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(initialHistory.hasMore);
  const [search, setSearch] = useState("");
  const cursor = useRef<string | undefined>(initialHistory.logs.at(-1)?.id);
  useEffect(() => {
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const connect = () => {
      if (!live || disposed) return;
      const params = new URLSearchParams(queryString);
      if (cursor.current) params.set("after", cursor.current);
      params.set("limit", "1000");
      const base = import.meta.env.DEV
        ? ""
        : (import.meta.env.VITE_API_URL ?? "");
      source = new EventSource(
        `${base}/api/projects/${project.id}/logs?${params}`,
        { withCredentials: true },
      );
      source.onopen = () => {
        setConnected(true);
        setStreamError(false);
      };
      source.onerror = () => {
        setConnected(false);
        setStreamError(true);
        source?.close();
        retry = setTimeout(connect, 1500);
      };
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as {
            type: string;
            logs?: ProjectLog[];
          } & ProjectLog;
          const incoming =
            payload.type === "replay"
              ? (payload.logs ?? [])
              : payload.type === "line"
                ? [payload]
                : [];
          if (incoming.length) {
            const last = incoming.at(-1)!;
            if (!cursor.current || BigInt(last.id) > BigInt(cursor.current))
              cursor.current = last.id;
            setLogs((current) =>
              mergeProjectLogs(current, incoming, MAX_LINES),
            );
          }
        } catch {
          /* Ignore malformed SSE frames. */
        }
      };
    };
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [live, project.id, queryString]);
  const labels = new Map(
    project.services.map((service) => [service.id, service.slug]),
  );
  const lines = logs.map(
    (log) =>
      `${log.containerTimestamp ?? log.createdAt} [${labels.get(log.serviceId) ?? log.serviceId.slice(0, 8)}] [${log.releaseId.slice(0, 8)}] [${log.stream}/${log.level}]${log.restartNumber ? ` [restart ${log.restartNumber}]` : ""} ${log.message}`,
  );
  const text = lines
    .filter(
      (line) => !search || line.toLowerCase().includes(search.toLowerCase()),
    )
    .join("\n");
  async function loadOlder() {
    if (!logs[0]) return;
    setLoadingOlder(true);
    setHistoryError("");
    try {
      const params = new URLSearchParams(queryString);
      params.set("before", logs[0].id);
      const page = await apiGet<History>(
        `/api/projects/${project.id}/log-history?${params}`,
      );
      setLogs((current) => mergeProjectLogs(current, page.logs, MAX_LINES));
      setHasOlder(page.hasMore);
    } catch (error) {
      setHistoryError(
        error instanceof Error ? error.message : "Could not load older logs",
      );
    } finally {
      setLoadingOlder(false);
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-48 flex-1"
          aria-label="Search loaded logs"
          placeholder="Search loaded logs"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {!historical ? (
          <Button
            variant="outline"
            onClick={() => {
              setConnected(false);
              setLive((value) => !value);
            }}
          >
            {live ? "Pause" : "Resume live"}
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={loadingOlder || !hasOlder || logs.length >= MAX_LINES}
          onClick={() => void loadOlder()}
        >
          {loadingOlder ? "Loading…" : "Load older logs"}
        </Button>
      </div>
      {historyError ? (
        <p role="alert" className="text-sm text-destructive">
          {historyError}
        </p>
      ) : null}
      {streamError && live ? (
        <p role="status" className="text-xs text-amber-600">
          Live connection interrupted. Reconnecting automatically from retained
          output.
        </p>
      ) : null}
      <LogPane
        className="h-[min(65vh,700px)]"
        text={text}
        emptyText={
          search
            ? "No matching loaded lines."
            : "No retained output matches these filters."
        }
        downloadName={`sohwe-${project.slug}-logs.log`}
        toolbarLeft={
          <span>
            {historical
              ? "Historical output"
              : live
                ? connected
                  ? "Live service output"
                  : "Connecting…"
                : "Paused"}{" "}
            · timestamps UTC
          </span>
        }
      />
      <p className="text-xs text-muted-foreground">
        Showing {logs.length.toLocaleString()} retained events; up to{" "}
        {MAX_LINES.toLocaleString()} can be loaded. Search, copy and download
        use the loaded, filtered output. Older records are subject to project
        retention.
      </p>
    </div>
  );
}

function LogStream(props: {
  project: ProjectRow;
  queryString: string;
  historical: boolean;
}) {
  const history = useQuery({
    queryKey: ["project-log-history", props.project.id, props.queryString],
    queryFn: () =>
      apiGet<History>(
        `/api/projects/${props.project.id}/log-history?${props.queryString}`,
      ),
  });
  if (history.isPending) return <p role="status">Loading retained logs…</p>;
  if (!history.data)
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load retained logs.{" "}
        <button className="underline" onClick={() => void history.refetch()}>
          Retry
        </button>
      </p>
    );
  return <ProjectLogOutput {...props} initialHistory={history.data} />;
}

export function ProjectLogsPage() {
  const { data: project } = useProject();
  const search = useSearch({ strict: false }) as {
    serviceId?: string;
    releaseId?: string;
  };
  const navigate = useNavigate();
  const [stream, setStream] = useState("");
  const [level, setLevel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState("");
  if (!project) return null;
  const params = new URLSearchParams({ limit: "200" });
  if (search.serviceId) params.set("serviceId", search.serviceId);
  if (search.releaseId) params.set("releaseId", search.releaseId);
  if (stream) params.set("stream", stream);
  if (level) params.set("level", level);
  if (range) {
    params.set("from", range.from);
    params.set("to", range.to);
  }
  const selectClass =
    "h-9 min-w-40 max-w-full rounded-md border bg-background px-3 text-sm";
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">
          Service and release-job logs
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Persisted output remains available after a container is replaced. Open
          a release for build logs.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <select
          aria-label="Log service"
          className={selectClass}
          value={search.serviceId ?? ""}
          onChange={(event) =>
            void navigate({
              to: "/projects/$projectId/logs",
              params: { projectId: project.id },
              search: { ...search, serviceId: event.target.value || undefined },
            })
          }
        >
          <option value="">All services</option>
          {project.services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name} ({service.kind})
            </option>
          ))}
        </select>
        <select
          aria-label="Log release"
          className={selectClass}
          value={search.releaseId ?? ""}
          onChange={(event) =>
            void navigate({
              to: "/projects/$projectId/logs",
              params: { projectId: project.id },
              search: { ...search, releaseId: event.target.value || undefined },
            })
          }
        >
          <option value="">All retained releases</option>
          {search.releaseId &&
          !project.releases.some(
            (release) => release.id === search.releaseId,
          ) ? (
            <option value={search.releaseId}>
              Release {search.releaseId.slice(0, 8)}
            </option>
          ) : null}
          {project.releases.map((release) => (
            <option key={release.id} value={release.id}>
              {release.id.slice(0, 8)} · {release.status}
            </option>
          ))}
        </select>
        <select
          aria-label="Log stream"
          className={selectClass}
          value={stream}
          onChange={(event) => setStream(event.target.value)}
        >
          <option value="">All streams</option>
          {["stdout", "stderr", "system"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="Log severity"
          className={selectClass}
          value={level}
          onChange={(event) => setLevel(event.target.value)}
        >
          <option value="">All severities</option>
          {["debug", "info", "warn", "error"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </div>
      <form
        className="flex flex-wrap items-end gap-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const start = new Date(from),
            end = new Date(to);
          end.setSeconds(59, 999);
          if (
            !Number.isFinite(+start) ||
            !Number.isFinite(+end) ||
            start > end
          ) {
            setError(
              "Choose a valid start and end time, with the start before the end.",
            );
            return;
          }
          setError("");
          setRange({ from: start.toISOString(), to: end.toISOString() });
        }}
      >
        <label className="min-w-44 flex-1 space-y-1 text-xs font-medium">
          From
          <Input
            aria-label="Logs from"
            type="datetime-local"
            required
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="min-w-44 flex-1 space-y-1 text-xs font-medium">
          To
          <Input
            aria-label="Logs to"
            type="datetime-local"
            required
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <Button type="submit" variant="outline">
          Apply range
        </Button>
        {range ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setRange(null);
              setError("");
            }}
          >
            Back to live
          </Button>
        ) : null}
        <p className="w-full text-xs text-muted-foreground">
          Range inputs use your local timezone and filter when Sohwe recorded
          each event.
        </p>
        {error ? (
          <p role="alert" className="w-full text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </form>
      <LogStream
        key={`${project.id}-${params}`}
        project={project}
        queryString={params.toString()}
        historical={range !== null}
      />
    </div>
  );
}
