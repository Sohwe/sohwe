import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

function eventSourceBase(): string {
  return import.meta.env.DEV || !import.meta.env.VITE_API_URL
    ? ""
    : (import.meta.env.VITE_API_URL as string);
}

export function BuildLogViewer({
  deploymentId,
  className
}: {
  deploymentId: string;
  className?: string;
}) {
  const [text, setText] = useState<string>("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`${eventSourceBase()}/api/deployments/${deploymentId}/logs`);
    const append = (add: string) => {
      setText((t) => t + add);
    };
    es.onmessage = (ev) => {
      try {
        const j = JSON.parse(ev.data) as
          | { type: "replay"; text: string }
          | { type: "line"; line: string };
        if (j.type === "replay") append(j.text);
        if (j.type === "line") append(`${j.line}\n`);
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      /* auto-reconnect */
    };
    return () => {
      es.close();
    };
  }, [deploymentId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [text]);

  return (
    <ScrollArea className={cn("h-80 rounded-md border border-border bg-muted/30", className)}>
      <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground/90">
        {text || "—"}
        <div ref={bottom} />
      </pre>
    </ScrollArea>
  );
}

export function DeploymentStatusLine({ status }: { status: string | undefined }) {
  if (status === "pending")
    return <span className="text-amber-500">Queued — waiting to start</span>;
  if (status === "building")
    return <span className="text-amber-500">Building…</span>;
  if (status === "success" || status === "running")
    return <span className="text-emerald-500">Completed successfully</span>;
  if (status === "failed")
    return <span className="text-destructive">Failed</span>;
  if (status === "cancelled")
    return <span className="text-muted-foreground">Cancelled</span>;
  return <span className="text-muted-foreground">…</span>;
}
