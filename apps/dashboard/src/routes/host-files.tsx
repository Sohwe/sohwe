import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileBrowser } from "@/components/apps/FileBrowser";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { HostFsStatus } from "@/lib/types";

export function HostFilesPage() {
  const statusQuery = useQuery({
    queryKey: ["host-fs"],
    queryFn: () => apiGet<HostFsStatus>("/api/host-fs"),
    staleTime: Infinity
  });
  const roots = statusQuery.data?.roots ?? [];
  const [root, setRoot] = useState<string | null>(null);
  const activeRoot = root ?? roots[0] ?? null;

  if (statusQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (statusQuery.isError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {statusQuery.error instanceof Error ? statusQuery.error.message : "Could not load host file browser status"}
      </p>
    );
  }
  if (!statusQuery.data?.enabled || !activeRoot) {
    return (
      <div>
        <PageHeader title="Host files" description="Read-only browser for allowlisted paths on the instance host." />
        <EmptyState
          title="Not enabled"
          description="Set SOHWE_HOST_FS_ALLOWLIST to a comma-separated list of absolute host paths (e.g. /etc/sohwe) in /etc/sohwe/sohwe.env — or apps/api/.env in development — then restart the API. Every listed directory and file read is recorded in the audit log."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Host files" description="Read-only browser for allowlisted paths on the instance host. Every list and read is audited." />
      {roots.length > 1 ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {roots.map((r) => (
            <Button
              key={r}
              type="button"
              size="sm"
              variant={r === activeRoot ? "secondary" : "outline"}
              className={cn("font-mono text-xs", r === activeRoot && "pointer-events-none")}
              onClick={() => setRoot(r)}
            >
              {r}
            </Button>
          ))}
        </div>
      ) : null}
      <FileBrowser
        key={activeRoot}
        rootPath={activeRoot}
        listUrl={(p) => `/api/host-fs/list?path=${encodeURIComponent(p)}`}
        fileUrl={(p) => `/api/host-fs/file?path=${encodeURIComponent(p)}`}
        title="Host files"
        description={`Read-only view under ${activeRoot}. In production only paths mounted into the API container are readable.`}
      />
    </div>
  );
}
