import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, Folder, FolderUp } from "lucide-react";
import { FilePreviewDialog } from "./FilePreviewDialog";
import { Button } from "@/components/ui/button";
import { Section, SectionContent, SectionHeader } from "@/components/common/Section";
import { EmptyState } from "@/components/common/EmptyState";
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
    <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-xs text-muted-foreground" aria-label="Path">
      {items.map((c, i) => (
        <span key={c.path} className="inline-flex items-center">
          {i > 0 ? <ChevronRight className="mx-0.5 h-3 w-3 text-muted-foreground/50" /> : null}
          <Button type="button" variant="ghost" className="h-7 max-w-48 px-1.5 text-xs" onClick={() => onPath(c.path)}>
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
    <Section className="overflow-hidden">
      <SectionHeader title={title} description={description} />
      <div className="border-b border-border/70 bg-muted/20 px-4 py-2.5">
        <Crumbs path={path} rootPath={rootPath} onPath={setPath} />
      </div>
      <SectionContent className="p-2">

      {listQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading directory…</p> : null}
      {listQuery.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {listQuery.error instanceof Error ? listQuery.error.message : "Could not list directory"}
        </p>
      ) : null}

      {listQuery.data ? (
        <ul className="max-h-80 space-y-0.5 overflow-auto font-mono text-sm">
          {path !== rootPath ? (
            <li>
              <Button type="button" variant="ghost" className="h-9 w-full justify-start gap-2 px-2 text-muted-foreground" onClick={() => setPath(parentFsPath(path))}>
                <FolderUp className="h-4 w-4" /> ..
              </Button>
            </li>
          ) : null}
          {listQuery.data.entries.map((e) => (
            <li key={e.name}>
              {e.kind === "file" ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-9 w-full justify-start gap-2 px-2 font-mono text-foreground"
                  onClick={() => setPreviewPath(joinFsPath(path, e.name))}
                >
                  <File className="h-4 w-4 text-muted-foreground" /> {e.name}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-9 w-full justify-start gap-2 px-2 font-mono text-foreground"
                  onClick={() => setPath(joinFsPath(path, e.name))}
                >
                  <Folder className="h-4 w-4 text-primary" /> {e.name}
                  {e.kind === "symlink" ? " →" : "/"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {listQuery.data?.entries.length === 0 ? (
        <EmptyState icon={Folder} title="This folder is empty" className="m-2 min-h-40 border-0 bg-transparent" />
      ) : null}

      {previewPath ? (
        <FilePreviewDialog url={fileUrl(previewPath)} path={previewPath} onClose={() => setPreviewPath(null)} />
      ) : null}
      </SectionContent>
    </Section>
  );
}
