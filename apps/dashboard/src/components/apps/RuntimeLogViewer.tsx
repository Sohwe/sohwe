import { LogPane } from "./LogPane";
import { useLogStream } from "@/lib/log-stream";
import { cn } from "@/lib/utils";

export function RuntimeLogViewer({
  appId,
  appSlug,
  className
}: {
  appId: string;
  appSlug?: string | undefined;
  className?: string;
}) {
  const { text, connected } = useLogStream(`/api/applications/${appId}/logs`);

  return (
    <LogPane
      className={cn("h-[min(70vh,560px)] rounded-md border border-border", className)}
      text={text}
      emptyText="No runtime logs yet."
      downloadName={`sohwe-runtime-${appSlug ?? appId}.log`}
      toolbarLeft={
        connected ? (
          <span>Streaming</span>
        ) : (
          <span className="text-amber-500">Reconnecting…</span>
        )
      }
    />
  );
}
