import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Tone = "success" | "warning" | "destructive" | "secondary" | "default";

const ACTIVE = new Set(["deploying", "building", "pending", "provisioning", "deleting", "restoring"]);

function toneFor(status: string): Tone {
  if (["running", "success", "ready", "healthy", "connected"].includes(status)) return "success";
  if (["failed", "error", "unhealthy"].includes(status)) return "destructive";
  if (ACTIVE.has(status)) return "warning";
  return "secondary";
}

export function StatusBadge({ status, label, className }: { status: string; label?: string; className?: string }) {
  const tone = toneFor(status);
  const active = ACTIVE.has(status);
  return (
    <Badge variant={tone} className={cn("gap-1.5 capitalize", className)}>
      <span className="relative flex h-1.5 w-1.5">
        {active ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" /> : null}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      </span>
      {label ?? status}
    </Badge>
  );
}
