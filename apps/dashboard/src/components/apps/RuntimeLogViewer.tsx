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
      className={cn("h-[min(68vh,600px)]", className)}
      text={text}
      emptyText="No runtime logs yet."
      downloadName={`sohwe-runtime-${appSlug ?? appId}.log`}
      toolbarLeft={
        connected ? (
          <span className="inline-flex items-center gap-1.5"><span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" /><span className="relative h-1.5 w-1.5 rounded-full bg-emerald-400" /></span> Live runtime output</span>
        ) : (
          <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Reconnecting</span>
        )
      }
    />
  );
}
