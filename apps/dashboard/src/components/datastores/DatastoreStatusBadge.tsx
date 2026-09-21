import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/common/StatusBadge";

export function DatastoreStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={status} label={status === "error" ? "Error" : undefined} />;
}

export function DatastoreKindBadge({ kind }: { kind: string }) {
  return (
    <Badge variant="outline" className="font-mono">
      {kind}
    </Badge>
  );
}
