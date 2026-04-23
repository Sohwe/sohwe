import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";
import { EnvManager } from "@/components/apps/EnvManager";
import { PageHeader } from "@/components/common/PageHeader";

export function AppVariablesPage() {
  const { appId } = useParams({ strict: false });
  const q = useQuery({ queryKey: ["applications"], queryFn: () => api<AppRow[]>("/api/applications") });
  const app = q.data?.find((a) => a.id === appId);
  const queryClient = useQueryClient();
  if (!appId || !app) return null;
  return (
    <div>
      <PageHeader title="Environment variables" description="Encrypted at rest. Redeploy to apply in the running container." />
      <EnvManager
        appId={appId}
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ["applications"] });
        }}
      />
    </div>
  );
}
