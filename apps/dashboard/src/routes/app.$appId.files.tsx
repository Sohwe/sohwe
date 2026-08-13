import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";
import { FileBrowser } from "@/components/apps/FileBrowser";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";

export function AppFilesPage() {
  const { appId } = useParams({ strict: false });
  const q = useQuery({ queryKey: ["applications"], queryFn: () => api<AppRow[]>("/api/applications") });
  const app = q.data?.find((a) => a.id === appId);
  if (!appId || !app) return null;
  if (app.status !== "running") {
    return (
      <EmptyState
        title="Not available"
        description="The file browser is only available while the app container is running. Deploy or wait for the app to be healthy, then return here."
      />
    );
  }
  return (
    <div>
      <PageHeader title="Container files" description="Read-only. Browse the running container, including volume mounts." />
      <FileBrowser
        listUrl={(p) => `/api/applications/${appId}/fs/list?path=${encodeURIComponent(p)}`}
        fileUrl={(p) => `/api/applications/${appId}/fs/file?path=${encodeURIComponent(p)}`}
        title="Container files"
        description="Read-only view of the running container filesystem. Browse mounted volumes and app files."
      />
    </div>
  );
}
