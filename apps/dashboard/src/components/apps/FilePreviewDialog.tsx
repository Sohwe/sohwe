import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiGet } from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FsFileResponse } from "@/lib/types";

export function FilePreviewDialog({
  appId,
  path: filePath,
  onClose
}: {
  appId: string;
  path: string;
  onClose: () => void;
}) {
  const fileQuery = useQuery({
    queryKey: ["fs-file", appId, filePath],
    queryFn: () =>
      apiGet<FsFileResponse>(`/api/applications/${appId}/fs/file?path=${encodeURIComponent(filePath)}`)
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate font-mono text-left text-sm">{filePath}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0">
          {fileQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading file…</p> : null}
          {fileQuery.isError ? (
            <p className="text-sm text-destructive">
              {fileQuery.error instanceof Error ? fileQuery.error.message : "Could not read file"}
            </p>
          ) : null}
          {fileQuery.data ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                {fileQuery.data.size} bytes
                {fileQuery.data.encoding === "base64" ? " · binary (base64)" : " · text"}
                {fileQuery.data.truncated ? " · preview truncated at 512 KiB" : ""}
              </p>
              <ScrollArea className="h-72 max-h-[60vh] rounded-md border border-border">
                <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs">{fileQuery.data.content}</pre>
              </ScrollArea>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
