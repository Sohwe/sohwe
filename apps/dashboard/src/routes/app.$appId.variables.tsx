import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";
import { BuildArgsManager } from "@/components/apps/BuildArgsManager";
import { EnvManager } from "@/components/apps/EnvManager";
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
        description="Encrypted at rest. Redeploy to apply — runtime variables reach the container, build variables reach the image build."
      />
      <EnvManager appId={appId} onChanged={invalidate} />
      <BuildArgsManager appId={appId} onChanged={invalidate} />
    </div>
  );
}
