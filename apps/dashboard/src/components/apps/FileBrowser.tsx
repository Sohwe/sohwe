import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FilePreviewDialog } from "./FilePreviewDialog";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api";
import { joinFsPath, parentFsPath, type FsListResponse } from "@/lib/types";

function Crumbs({
  path,
  rootPath,
  onPath
}: {
  path: string;
  rootPath: string;
  onPath: (p: string) => void;
}) {
  const items = useMemo(() => {
    const rootLabel = rootPath === "/" ? "root" : rootPath;
    const out: { label: string; path: string }[] = [
      { label: rootLabel, path: rootPath }
    ];
    if (path !== rootPath) {
      const rest = rootPath === "/" ? path : path.slice(rootPath.length);
      let acc = rootPath === "/" ? "" : rootPath;
      for (const seg of rest.split("/").filter(Boolean)) {
        acc = `${acc}/${seg}`;
        out.push({ label: seg, path: acc });
      }
    }
    return out;
  }, [path, rootPath]);
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

/**
 * Generic read-only filesystem browser over any pair of list/file endpoints
 * that speak FsListResponse/FsFileResponse — the app container filesystem and
 * the host file browser both render through this. `rootPath` fences navigation:
 * breadcrumbs stop there and ".." never goes above it.
 */
export function FileBrowser({
  listUrl,
  fileUrl,
  title,
  description,
  rootPath = "/"
}: {
  listUrl: (path: string) => string;
  fileUrl: (path: string) => string;
  title: string;
  description: string;
  rootPath?: string;
}) {
  const [path, setPath] = useState(rootPath);
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["fs-list", listUrl(path)],
    queryFn: () => apiGet<FsListResponse>(listUrl(path)),
    staleTime: 15_000
  });

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card/30 p-4">
      <div>
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Crumbs path={path} rootPath={rootPath} onPath={setPath} />

      {listQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading directory…</p> : null}
      {listQuery.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {listQuery.error instanceof Error ? listQuery.error.message : "Could not list directory"}
        </p>
      ) : null}

      {listQuery.data ? (
        <ul className="max-h-64 space-y-0.5 overflow-auto font-mono text-sm">
          {path !== rootPath ? (
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

      {previewPath ? (
        <FilePreviewDialog url={fileUrl(previewPath)} path={previewPath} onClose={() => setPreviewPath(null)} />
      ) : null}
    </div>
  );
}
