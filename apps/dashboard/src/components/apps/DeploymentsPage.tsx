import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { BuildLogViewer, DeploymentStatusLine } from "./BuildLogViewer";
import { DeploymentsTable } from "./DeploymentsTable";
import { PageHeader } from "@/components/common/PageHeader";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";

export function DeploymentsPage() {
  const { appId, deploymentId } = useParams({ strict: false });
  if (!appId) throw new Error("appId");
  const queryClient = useQueryClient();
  const router = useRouter();
  const [rollBackId, setRollBackId] = useState<string | null>(null);
  const logOpen = Boolean(deploymentId);

  const appsQuery = useQuery({
    queryKey: ["applications"],
    queryFn: () => api<AppRow[]>("/api/applications"),
    refetchInterval: (q) => {
      const list = q.state.data;
      const a = list?.find((x) => x.id === appId);
      if (!a) return false;
      const d = a.deployments?.find((d0) => d0.id === deploymentId);
      if (d && (d.status === "pending" || d.status === "building")) return 2000;
      if (a.status === "deploying") return 2000;
      return false;
    }
  });
  const app = appsQuery.data?.find((a) => a.id === appId);

  const watchDep = useMemo(() => {
    if (!app || !deploymentId) return undefined;
    return app.deployments?.find((d) => d.id === deploymentId);
  }, [app, deploymentId]);

  const rollbackMut = useMutation({
    mutationFn: (sourceDeploymentId: string) =>
      api<{ deployment: { id: string } }>(`/api/applications/${appId}/rollback`, {
        method: "POST",
        body: JSON.stringify({ sourceDeploymentId })
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      toast.success("Roll back started");
      void router.navigate({
        to: "/apps/$appId/deployments/$deploymentId",
        params: { appId, deploymentId: data.deployment.id }
      });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Roll back failed");
    }
  });

  const onOpenLog = (id: string) => {
    void router.navigate({ to: "/apps/$appId/deployments/$deploymentId", params: { appId, deploymentId: id } });
  };

  const onCloseLog = () => {
    void router.navigate({ to: "/apps/$appId/deployments", params: { appId } });
  };

  if (!app) return null;

  return (
    <div>
      <PageHeader title="Deployments" description="Build logs stream over SSE. Roll back to a previous successful build." />
      <DeploymentsTable
        app={app}
        onViewLog={onOpenLog}
        onRollBack={(id) => setRollBackId(id)}
        actionsDisabled={app.status === "deploying" || rollbackMut.isPending}
      />
      <Sheet open={logOpen} onOpenChange={(o) => !o && onCloseLog()}>
        <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <SheetHeader className="border-b border-border p-4 text-left">
            <SheetTitle>Build log</SheetTitle>
            {watchDep ? (
              <div className="space-y-1 text-left text-xs text-muted-foreground">
                <DeploymentStatusLine status={watchDep.status} />
                {watchDep.status === "failed" && watchDep.errorMessage ? (
                  <p className="text-destructive">{watchDep.errorMessage}</p>
                ) : null}
              </div>
            ) : null}
          </SheetHeader>
          {deploymentId ? (
            <div className="min-h-0 flex-1 overflow-hidden p-4">
              <BuildLogViewer deploymentId={deploymentId} className="h-[min(70vh,480px)] border-0" />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={rollBackId != null}
        onOpenChange={(o) => !o && setRollBackId(null)}
        title="Roll back"
        description="The app will restart using that image. Continue?"
        confirmLabel="Roll back"
        onConfirm={() => {
          if (rollBackId) void rollbackMut.mutateAsync(rollBackId);
          setRollBackId(null);
        }}
      />
    </div>
  );
}
