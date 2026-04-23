import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";
import { VolumesManager } from "@/components/apps/VolumesManager";
import { PageHeader } from "@/components/common/PageHeader";

export function AppVolumesPage() {
  const { appId } = useParams({ strict: false });
  const q = useQuery({ queryKey: ["applications"], queryFn: () => api<AppRow[]>("/api/applications") });
  const app = q.data?.find((a) => a.id === appId);
  const queryClient = useQueryClient();
  if (!appId || !app) return null;
  return (
    <div>
      <PageHeader title="Persistent volumes" description="Data survives redeploys. Add a mount, then redeploy." />
      <VolumesManager
        appId={appId}
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ["applications"] });
        }}
      />
    </div>
  );
}
