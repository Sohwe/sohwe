import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";
import { VariablesManager } from "@/components/apps/VariablesManager";
import { PageHeader } from "@/components/common/PageHeader";

export function AppVariablesPage() {
  const { appId } = useParams({ strict: false });
  const q = useQuery({ queryKey: ["applications"], queryFn: () => api<AppRow[]>("/api/applications") });
  const app = q.data?.find((a) => a.id === appId);
  const queryClient = useQueryClient();
  if (!appId || !app) return null;
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["applications"] });
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Variables"
        description="Encrypted at rest. One list — each variable applies to the build, the running container, or both. Redeploy to apply."
      />
      <VariablesManager appId={appId} onChanged={invalidate} />
    </div>
  );
}
