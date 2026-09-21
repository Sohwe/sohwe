import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { apiGet } from "@/lib/api";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import type { BundleRecord } from "@/lib/types";
import { DestinationsManager } from "@/components/backups/DestinationsManager";
import { SchedulesManager } from "@/components/backups/SchedulesManager";
import { ExportDialog } from "@/components/backups/ExportDialog";
import { RestoreDialog } from "@/components/backups/RestoreDialog";
import { ResourceItem, ResourceList } from "@/components/common/Section";
import { Badge } from "@/components/ui/badge";

export function BackupsPage() {
  const [exportOpen, setExportOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const bundlesQ = useQuery({
    queryKey: ["bundles"],
    queryFn: () => apiGet<{ bundles: BundleRecord[] }>("/api/backups")
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Backups"
        description="Export every app's config (and encrypted env vars) as a portable, signed bundle, then restore it here or on another Sohwe instance."
        actions={
          <>
            <Button type="button" variant="outline" onClick={() => setRestoreOpen(true)}>
              <Upload className="mr-2 h-4 w-4" />
              Restore
            </Button>
            <Button type="button" onClick={() => setExportOpen(true)}>
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent bundles</CardTitle>
          <CardDescription>
            A record of exports from this instance. Downloaded bundles are not
            stored on the server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {bundlesQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : null}
          {bundlesQ.isError ? (
            <p className="text-sm text-destructive">Could not load bundles.</p>
          ) : null}
          {bundlesQ.data ? (
            <ResourceList>
              {bundlesQ.data.bundles.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  No bundles yet.
                </li>
              ) : null}
              {bundlesQ.data.bundles.map((b) => (
                <ResourceItem key={b.id}>
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs">{b.filename}</p>
                    <p className="text-xs text-muted-foreground">
                      {b.appCount} app{b.appCount === 1 ? "" : "s"}
                      {b.includesSecrets ? " · env vars" : " · config only"}
                      {b.scheduleId
                        ? " · scheduled"
                        : b.destinationId
                          ? " · destination"
                          : " · download"}{" "}
                      · {formatRelativeTime(b.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    {b.sizeBytes ? (
                      <span className="text-muted-foreground">
                        {formatBytes(Number(b.sizeBytes))}
                      </span>
                    ) : null}
                    {b.status === "failed" ? (
                      <Badge variant="destructive">Failed</Badge>
                    ) : (
                      <Badge variant="success">Ready</Badge>
                    )}
                  </div>
                </ResourceItem>
              ))}
            </ResourceList>
          ) : null}
        </CardContent>
      </Card>

      <DestinationsManager />

      <SchedulesManager />

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <RestoreDialog open={restoreOpen} onOpenChange={setRestoreOpen} />
    </div>
  );
}
