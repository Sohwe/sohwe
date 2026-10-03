import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiGet } from "@/lib/api";
import { useLogStream } from "@/lib/log-stream";
import { cn } from "@/lib/utils";
import { LogPane } from "./LogPane";

type Range = { from: string; to: string };
type History = { text: string; count: number; truncated: boolean };

function LiveRuntimeLogs({ appId, appSlug, className }: {
  appId: string;
  appSlug?: string;
  className?: string;
}) {
  const { text, connected } = useLogStream(`/api/applications/${appId}/logs`);
  return <LogPane
    className={cn("h-[min(68vh,600px)]", className)}
    text={text}
    emptyText="No runtime logs yet."
    downloadName={`sohwe-runtime-${appSlug ?? appId}.log`}
    toolbarLeft={connected ? (
      <span className="inline-flex items-center gap-1.5"><span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" /><span className="relative h-1.5 w-1.5 rounded-full bg-emerald-400" /></span> Live runtime output</span>
    ) : (
      <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Reconnecting</span>
    )}
  />;
}

function HistoricalRuntimeLogs({ appId, appSlug, range, className }: {
  appId: string;
  appSlug?: string;
  range: Range;
  className?: string;
}) {
  const query = useQuery({
    queryKey: ["application-runtime-log-history", appId, range.from, range.to],
    queryFn: () => apiGet<History>(`/api/applications/${appId}/log-history?${new URLSearchParams(range)}`)
  });
  return <div className="space-y-2">
    {query.isError ? <p role="alert" className="text-sm text-destructive">{query.error instanceof Error ? query.error.message : "Could not load logs for this range."}</p> : null}
    {query.data?.truncated ? <p role="status" className="text-xs text-amber-600">Showing the latest 1,000 lines in this range. Narrow the range to see earlier output.</p> : null}
    <LogPane
      className={cn("h-[min(68vh,600px)]", className)}
      text={query.data?.text ?? ""}
      emptyText={query.isPending ? "Loading logs…" : query.isError ? "Could not load logs for this range." : "No retained runtime logs in this range."}
      downloadName={`sohwe-runtime-${appSlug ?? appId}-range.log`}
      toolbarLeft={<span>{query.data ? `${query.data.count.toLocaleString()} lines in selected range` : "Runtime log history"}</span>}
    />
  </div>;
}

export function RuntimeLogViewer({
  appId,
  appSlug,
  className
}: {
  appId: string;
  appSlug?: string | undefined;
  className?: string;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [range, setRange] = useState<Range | null>(null);
  const [error, setError] = useState<string | null>(null);

  return <div className="space-y-3">
    <form className="flex flex-wrap items-end gap-3 rounded-lg border border-border/70 p-3" onSubmit={(event) => {
      event.preventDefault();
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        setError("Choose both a start and end date and time.");
        return;
      }
      if (fromDate > toDate) {
        setError("Start must be before end.");
        return;
      }
      // datetime-local inputs select a minute. Include that entire minute.
      toDate.setSeconds(59, 999);
      setError(null);
      setRange({ from: fromDate.toISOString(), to: toDate.toISOString() });
    }}>
      <label className="min-w-44 flex-1 space-y-1 text-xs font-medium">
        <span>From</span>
        <Input aria-label="Logs from date and time" type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} required />
      </label>
      <label className="min-w-44 flex-1 space-y-1 text-xs font-medium">
        <span>To</span>
        <Input aria-label="Logs to date and time" type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} required />
      </label>
      <Button type="submit" size="sm">Apply range</Button>
      {range ? <Button type="button" variant="outline" size="sm" onClick={() => { setRange(null); setError(null); }}>Back to live</Button> : null}
      {error ? <p role="alert" className="w-full text-xs text-destructive">{error}</p> : null}
      <p className="w-full text-xs text-muted-foreground">Range inputs use your local timezone; log timestamps are UTC. Results come from the latest container's retained Docker logs, including after a crash. Logs from removed deployments are unavailable.</p>
    </form>
    {range ? <HistoricalRuntimeLogs appId={appId} appSlug={appSlug} range={range} className={className} /> : <LiveRuntimeLogs appId={appId} appSlug={appSlug} className={className} />}
  </div>;
}
