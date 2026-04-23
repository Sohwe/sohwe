import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FilePreviewDialog } from "./FilePreviewDialog";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api";
import { joinFsPath, parentFsPath, type FsListResponse } from "@/lib/types";

function Crumbs({
  path,
  onPath
}: {
  path: string;
  onPath: (p: string) => void;
}) {
  const items = useMemo(() => {
    if (path === "/") return [{ label: "root", path: "/" as const }];
    const segments = path.split("/").filter(Boolean);
    const out: { label: string; path: string }[] = [{ label: "root", path: "/" }];
    let acc = "";
    for (const seg of segments) {
      acc = `${acc}/${seg}`;
      out.push({ label: seg, path: acc });
    }
    return out;
  }, [path]);
  return (
    <nav className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground" aria-label="Path">
      {items.map((c, i) => (
        <span key={c.path} className="inline-flex items-center">
          {i > 0 ? <span className="px-0.5 text-border">/</span> : null}
          <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => onPath(c.path)}>
            {c.label}
          </Button>
        </span>
      ))}
    </nav>
  );
}

export function FileBrowser({ appId }: { appId: string }) {
  const [path, setPath] = useState("/");
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["fs-list", appId, path],
    queryFn: () => apiGet<FsListResponse>(`/api/applications/${appId}/fs/list?path=${encodeURIComponent(path)}`),
    staleTime: 15_000
  });

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card/30 p-4">
      <div>
        <p className="text-xs font-medium text-muted-foreground">Container files</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Read-only view of the running container filesystem. Browse mounted volumes and app files.
        </p>
      </div>
      <Crumbs path={path} onPath={setPath} />

      {listQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading directory…</p> : null}
      {listQuery.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {listQuery.error instanceof Error ? listQuery.error.message : "Could not list directory"}
        </p>
      ) : null}

      {listQuery.data ? (
        <ul className="max-h-64 space-y-0.5 overflow-auto font-mono text-sm">
          {path !== "/" ? (
            <li>
              <Button type="button" variant="link" className="h-auto p-0 text-foreground" onClick={() => setPath(parentFsPath(path))}>
                ..
              </Button>
            </li>
          ) : null}
          {listQuery.data.entries.map((e) => (
            <li key={e.name}>
              {e.kind === "file" ? (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-primary"
                  onClick={() => setPreviewPath(joinFsPath(path, e.name))}
                >
                  {e.name}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-emerald-600 dark:text-emerald-400"
                  onClick={() => setPath(joinFsPath(path, e.name))}
                >
                  {e.name}
                  {e.kind === "symlink" ? " →" : "/"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {previewPath ? <FilePreviewDialog appId={appId} path={previewPath} onClose={() => setPreviewPath(null)} /> : null}
    </div>
  );
}
