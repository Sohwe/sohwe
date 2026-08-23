import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";
import { DomainsManager } from "@/components/apps/DomainsManager";
import { PageHeader } from "@/components/common/PageHeader";

export function AppDomainsPage() {
  const { appId } = useParams({ strict: false });
  const q = useQuery({
    queryKey: ["applications"],
    queryFn: () => api<AppRow[]>("/api/applications")
  });
  const app = q.data?.find((a) => a.id === appId);
  if (!appId || !app) return null;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Domains"
        description="Custom hostnames for this app, their DNS status, and the records they need."
      />
      <DomainsManager app={app} />
    </div>
  );
}
