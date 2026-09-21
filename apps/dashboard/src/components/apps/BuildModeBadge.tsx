import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/common/StatusBadge";

export function BuildModeBadge({ mode }: { mode: string }) {
  if (mode === "dockerfile")
    return <Badge className="font-mono">dockerfile</Badge>;
  if (mode === "nixpacks")
    return (
      <Badge variant="warning" className="font-mono">
        nixpacks
      </Badge>
    );
  return (
    <Badge variant="secondary" className="font-mono">
      {mode}
    </Badge>
  );
}

export function AppStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={status} label={status === "error" || status === "failed" ? "Error" : undefined} />;
}
