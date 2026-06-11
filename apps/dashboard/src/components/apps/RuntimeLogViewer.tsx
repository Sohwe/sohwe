import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

function eventSourceBase(): string {
  return import.meta.env.DEV || !import.meta.env.VITE_API_URL
    ? ""
    : (import.meta.env.VITE_API_URL as string);
}

export function RuntimeLogViewer({
  appId,
  className
}: {
  appId: string;
  className?: string;
}) {
  const [text, setText] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`${eventSourceBase()}/api/applications/${appId}/logs`);
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
        /* EventSource reconnects automatically. */
      }
    };

    return () => {
      es.close();
    };
  }, [appId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [text]);

  return (
    <ScrollArea className={cn("h-[min(70vh,560px)] rounded-md border border-border bg-muted/30", className)}>
      <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground/90">
        {text || "No runtime logs yet."}
        <div ref={bottom} />
      </pre>
    </ScrollArea>
  );
}
