import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, Download } from "lucide-react";
import { toast } from "sonner";
import { CopyButton } from "@/components/common/CopyButton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function download(text: string, filename: string): void {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    toast.error("Could not download logs");
  }
}

/**
 * Scrolling log viewer with copy/download and sticky-bottom following.
 *
 * Following is on until the reader scrolls away from the bottom; without that
 * an arriving line yanks the view back down mid-read, which makes a streaming
 * build log unreadable.
 */
export function LogPane({
  text,
  emptyText,
  downloadName,
  toolbarLeft,
  className
}: {
  text: string;
  emptyText: string;
  /** File name used by the download button. */
  downloadName: string;
  toolbarLeft?: ReactNode;
  className?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  const scrollToBottom = useCallback(() => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (following) scrollToBottom();
  }, [text, following, scrollToBottom]);

  const onScroll = () => {
    const el = viewport.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollowing(atBottom);
  };

  const hasText = text.length > 0;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
        <div className="min-w-0 truncate text-xs text-muted-foreground">{toolbarLeft}</div>
        <div className="flex shrink-0 items-center gap-1">
          {!following ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => {
                setFollowing(true);
                scrollToBottom();
              }}
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
              Follow
            </Button>
          ) : null}
          <CopyButton text={text} label="Copy logs" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Download logs"
            disabled={!hasText}
            onClick={() => download(text, downloadName)}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div
        ref={viewport}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto bg-muted/30"
      >
        <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground/90">
          {hasText ? text : emptyText}
        </pre>
      </div>
    </div>
  );
}
