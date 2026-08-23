import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { apiGet } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { AuditLogEntry, AuditLogPage } from "@/lib/types";

const PAGE_SIZE = 50;

/** Sentinel for the "all actions" option; `Select` cannot hold an empty value. */
const ALL = "__all__";

function actionVariant(action: string): "default" | "destructive" | "warning" | "secondary" {
  if (action.endsWith(".delete") || action === "member.remove") return "destructive";
  if (action.endsWith(".reveal") || action === "backup.restore") return "warning";
  if (action.startsWith("deployment.")) return "default";
  return "secondary";
}

/**
 * Metadata is deliberately non-secret (key names, counts, roles), so it is safe
 * to render verbatim. Rendered compactly: this table is scanned, not read.
 */
function MetadataCell({ metadata }: { metadata: AuditLogEntry["metadata"] }) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const parts = Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`);
  if (parts.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="font-mono text-xs text-muted-foreground" title={parts.join(" ")}>
      {parts.join(" ")}
    </span>
  );
}

export function AuditPage() {
  const [action, setAction] = useState(ALL);
  // Cursor stack so "Previous" can walk back; the API is forward-cursor only.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;

  const actionsQuery = useQuery({
    queryKey: ["audit-actions"],
    queryFn: () => apiGet<{ actions: string[] }>("/api/audit-logs/actions"),
    staleTime: Infinity
  });

  const query = useQuery({
    queryKey: ["audit-logs", action, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (action !== ALL) params.set("action", action);
      if (cursor) params.set("cursor", cursor);
      return apiGet<AuditLogPage>(`/api/audit-logs?${params.toString()}`);
    }
  });

  const items = query.data?.items ?? [];
  const page = cursors.length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit log"
        description="Who changed what in this organization. Secret values are never recorded — only key names, counts, and roles."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={action}
          onValueChange={(v) => {
            setAction(v);
            setCursors([null]);
          }}
        >
          <SelectTrigger className="h-9 w-64">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All actions</SelectItem>
            {(actionsQuery.data?.actions ?? []).map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="pt-6">
          {query.isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : query.isError ? (
            <p className="text-sm text-destructive">
              {query.error instanceof Error ? query.error.message : "Could not load the audit log"}
            </p>
          ) : items.length === 0 ? (
            <EmptyState
              title="Nothing recorded yet"
              description={
                action === ALL
                  ? "Actions taken in the dashboard show up here as they happen."
                  : "No events match this filter."
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell
                      className="whitespace-nowrap text-sm text-muted-foreground"
                      title={formatDateTime(e.createdAt)}
                    >
                      {formatRelativeTime(e.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {e.actor.name ?? e.actor.email}
                      {e.actor.deleted ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">(removed)</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={actionVariant(e.action)}>{e.action}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {e.targetLabel ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="max-w-sm truncate">
                      <MetadataCell metadata={e.metadata} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {items.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Page {page}</span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursors.length <= 1}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!query.data?.nextCursor}
              onClick={() =>
                setCursors((c) =>
                  query.data?.nextCursor ? [...c, query.data.nextCursor] : c
                )
              }
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
