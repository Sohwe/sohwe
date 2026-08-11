import { AlertOctagon } from "lucide-react";
import { CopyButton } from "@/components/common/CopyButton";
import type { AppRow } from "@/lib/types";
import { cn } from "@/lib/utils";

type Deployment = NonNullable<AppRow["deployments"]>[number];

/**
 * The worker writes `errorMessage` as a short diagnosis: a headline, the log
 * lines that justify it, an optional "Try:" hint, and the raw build error last.
 * Rendering it verbatim in a monospace block keeps that structure intact and
 * puts the cause above the log instead of buried hundreds of lines into it.
 */
export function BuildFailureSummary({
  deployment,
  className
}: {
  deployment: Deployment | undefined;
  className?: string;
}) {
  if (!deployment || deployment.status !== "failed" || !deployment.errorMessage) {
    return null;
  }
  const [headline, ...rest] = deployment.errorMessage.split("\n");
  const detail = rest.join("\n").trim();

  return (
    <div
      className={cn(
        "rounded-md border border-destructive/40 bg-destructive/5 p-3",
        className
      )}
    >
      <div className="flex items-start gap-2">
        <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-destructive">{headline}</p>
          {detail ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
              {detail}
            </pre>
          ) : null}
        </div>
        <CopyButton text={deployment.errorMessage} label="Copy failure details" />
      </div>
    </div>
  );
}
