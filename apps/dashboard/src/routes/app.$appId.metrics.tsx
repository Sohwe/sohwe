import { useParams } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/PageHeader";
import { AppMetrics } from "@/components/apps/AppMetrics";

export function AppMetricsPage() {
  const { appId } = useParams({ strict: false });
  if (!appId) throw new Error("appId");

  return (
    <div>
      <PageHeader
        title="Metrics"
        description="Live CPU and memory usage for the running app container."
      />
      <AppMetrics appId={appId} />
    </div>
  );
}
