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
        description="Encrypted at rest. Variables reach the running container by default; enable build access when needed. Redeploy to apply."
      />
      <VariablesManager path={`/api/applications/${appId}/variables`} onChanged={invalidate} />
    </div>
  );
}
