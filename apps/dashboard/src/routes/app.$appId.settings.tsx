import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";
import { AppSettingsForm } from "@/components/apps/AppSettingsForm";
import { AlertsManager } from "@/components/apps/AlertsManager";
import { PageHeader } from "@/components/common/PageHeader";

export function AppSettingsPage() {
  const { appId } = useParams({ strict: false });
  const q = useQuery({ queryKey: ["applications"], queryFn: () => api<AppRow[]>("/api/applications") });
  const app = q.data?.find((a) => a.id === appId);
  if (!appId || !app) return null;
  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Settings" description="Build, domain, and container limits. Save, then deploy to apply." />
        <AppSettingsForm app={app} />
      </div>
      <AlertsManager appId={appId} />
    </div>
  );
}
