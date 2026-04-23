import { Badge } from "@/components/ui/badge";

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
  const isDeploying = status === "deploying" || status === "building";
  if (isDeploying)
    return (
      <span className="inline-flex items-center gap-1.5 text-amber-500">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>
        <span className="text-xs font-medium">{status}</span>
      </span>
    );
  if (status === "running")
    return <Badge variant="success">Running</Badge>;
  if (status === "error" || status === "failed")
    return <Badge variant="destructive">Error</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}
