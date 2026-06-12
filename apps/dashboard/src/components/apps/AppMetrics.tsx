import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import type { AppStats } from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";

function Meter({
  label,
  percent,
  detail
}: {
  label: string;
  percent: number;
  detail: string;
}) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="font-mono text-muted-foreground">{detail}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function AppMetrics({ appId }: { appId: string }) {
  const q = useQuery({
    queryKey: ["app-stats", appId],
    queryFn: () => apiGet<AppStats>(`/api/applications/${appId}/stats`),
    refetchInterval: 3000
  });

  const stats = q.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Live resource usage</CardTitle>
        <CardDescription>
          CPU and memory for the running container, sampled every few seconds.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !stats || !stats.running ? (
          <p className="text-sm text-muted-foreground">
            No live stats. Deploy or start the app to see CPU and memory usage.
          </p>
        ) : (
          <>
            <Meter
              label="CPU"
              percent={stats.cpuPercent}
              detail={`${stats.cpuPercent.toFixed(1)}%`}
            />
            <Meter
              label="Memory"
              percent={stats.memPercent}
              detail={
                stats.memLimitBytes > 0
                  ? `${formatBytes(stats.memUsedBytes)} / ${formatBytes(stats.memLimitBytes)} (${stats.memPercent.toFixed(1)}%)`
                  : formatBytes(stats.memUsedBytes)
              }
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
