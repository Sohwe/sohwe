import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/PageHeader";
import { RuntimeLogViewer } from "@/components/apps/RuntimeLogViewer";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";

export function AppLogsPage() {
  const { appId } = useParams({ strict: false });
  if (!appId) throw new Error("appId");

  const appsQuery = useQuery({
    queryKey: ["applications"],
    queryFn: () => api<AppRow[]>("/api/applications"),
    staleTime: 30_000
  });
  const app = appsQuery.data?.find((a) => a.id === appId);
  const isRunning = app?.status === "running";

  return (
    <div>
      <PageHeader
        title="Runtime logs"
        description={
          isRunning
            ? "Live stdout and stderr from the running app container."
            : "Deploy or start the app to stream live container output."
        }
      />
      <RuntimeLogViewer appId={appId} />
    </div>
  );
}
