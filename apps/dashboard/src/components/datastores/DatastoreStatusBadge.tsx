import { Badge } from "@/components/ui/badge";

export function DatastoreStatusBadge({ status }: { status: string }) {
  const transitional = status === "provisioning" || status === "deleting";
  if (transitional)
    return (
      <span className="inline-flex items-center gap-1.5 text-amber-500">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>
        <span className="text-xs font-medium">{status}</span>
      </span>
    );
  if (status === "running") return <Badge variant="success">Running</Badge>;
  if (status === "error") return <Badge variant="destructive">Error</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

export function DatastoreKindBadge({ kind }: { kind: string }) {
  return (
    <Badge variant="outline" className="font-mono">
      {kind}
    </Badge>
  );
}
