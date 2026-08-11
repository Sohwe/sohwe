import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import { LogPane } from "./LogPane";
import { shortDepId } from "@/lib/format";
import { useLogStream } from "@/lib/log-stream";
import { cn } from "@/lib/utils";

export function BuildLogViewer({
  deploymentId,
  status,
  className
}: {
  deploymentId: string;
  status?: string | undefined;
  className?: string;
}) {
  const { text, connected } = useLogStream(`/api/deployments/${deploymentId}/logs`);
  const live = status === "pending" || status === "building";

  return (
    <LogPane
      className={cn("h-80 rounded-md border border-border", className)}
      text={text}
      emptyText={live ? "Waiting for build output…" : "No build output was recorded."}
      downloadName={`sohwe-build-${shortDepId(deploymentId)}.log`}
      toolbarLeft={
        live && !connected ? (
          <span className="text-amber-500">Reconnecting…</span>
        ) : live ? (
          <span>Streaming</span>
        ) : (
          <span>{text.length > 0 ? `${text.split("\n").length - 1} lines` : ""}</span>
        )
      }
    />
  );
}

/**
 * Deployment state as a labelled, coloured line. Kept distinct from the table's
 * short badge text so the detail view can be explicit about what "Queued" or
 * "Building" actually means right now.
 */
export function DeploymentStatusLine({ status }: { status: string | undefined }) {
  const spec = (():
    | { icon: typeof Loader2; text: string; className: string; spin?: boolean }
    | null => {
    switch (status) {
      case "pending":
        return {
          icon: CircleDashed,
          text: "Queued — waiting for a worker to pick this up",
          className: "text-amber-500"
        };
      case "building":
        return { icon: Loader2, text: "Building…", className: "text-amber-500", spin: true };
      case "success":
      case "running":
        return {
          icon: CheckCircle2,
          text: "Completed successfully",
          className: "text-emerald-500"
        };
      case "failed":
        return { icon: XCircle, text: "Failed", className: "text-destructive" };
      case "cancelled":
        return { icon: AlertTriangle, text: "Cancelled", className: "text-muted-foreground" };
      default:
        return null;
    }
  })();

  if (!spec) return <span className="text-muted-foreground">…</span>;
  const Icon = spec.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-medium", spec.className)}>
      <Icon className={cn("h-3.5 w-3.5", spec.spin && "animate-spin")} aria-hidden />
      {spec.text}
    </span>
  );
}
