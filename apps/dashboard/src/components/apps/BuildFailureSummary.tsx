import { AlertOctagon } from "lucide-react";
import { Link } from "@tanstack/react-router";
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
  appId,
  className
}: {
  deployment: Deployment | undefined;
  appId: string;
  className?: string;
}) {
  if (!deployment || deployment.status !== "failed" || !deployment.errorMessage) {
    return null;
  }
  const [headline, ...rest] = deployment.errorMessage.split("\n");
  const detail = rest.join("\n").trim();
  const remedy = (() => {
    if (/tracked Git branch was not found/i.test(headline)) return { label: "Change branch", field: "branch" };
    if (/configured Dockerfile could not be used/i.test(headline)) return { label: "Check Dockerfile path", field: "dockerfile-path" };
    if (/Nixpacks could not find a start command/i.test(headline)) return { label: "Set start command", field: "start-command" };
    if (/image has no start command/i.test(headline)) return { label: "Set container command", field: "runtime-command" };
    if (/Required variables are missing/i.test(headline)) return { label: "Add required variables", field: "variables" };
    if (/could not access the repository/i.test(headline)) return { label: "Check GitHub access", field: "git" };
    return null;
  })();

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
          {remedy ? (
            <div className="mt-3">
              {remedy.field === "git" ? (
                <Link to="/git" className="text-sm font-medium underline underline-offset-2">{remedy.label} →</Link>
              ) : remedy.field === "variables" ? (
                <Link to="/apps/$appId/variables" params={{ appId }} className="text-sm font-medium underline underline-offset-2">{remedy.label} →</Link>
              ) : (
                <Link to="/apps/$appId/settings" params={{ appId }} hash={remedy.field} className="text-sm font-medium underline underline-offset-2">{remedy.label} →</Link>
              )}
            </div>
          ) : null}
          <a className="mt-2 inline-block text-xs underline underline-offset-2" href="https://github.com/Sohwe/sohwe/blob/main/docs/deployment-troubleshooting.md" target="_blank" rel="noopener noreferrer">Deployment troubleshooting</a>
        </div>
        <CopyButton text={deployment.errorMessage} label="Copy failure details" />
      </div>
    </div>
  );
}
