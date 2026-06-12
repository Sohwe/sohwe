import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/PageHeader";
import { RuntimeLogViewer } from "@/components/apps/RuntimeLogViewer";
import { BuildLogViewer } from "@/components/apps/BuildLogViewer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";

type View = "runtime" | "build";

export function AppLogsPage() {
  const { appId } = useParams({ strict: false });
  if (!appId) throw new Error("appId");

  const [view, setView] = useState<View>("runtime");

  const appsQuery = useQuery({
    queryKey: ["applications"],
    queryFn: () => api<AppRow[]>("/api/applications"),
    staleTime: 30_000
  });
  const app = appsQuery.data?.find((a) => a.id === appId);
  const isRunning = app?.status === "running";

  const lastDeploymentId = app?.deployments?.length
    ? [...app.deployments].sort(
        (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)
      )[0]?.id
    : undefined;

  return (
    <div>
      <PageHeader
        title="Logs"
        description={
          view === "runtime"
            ? isRunning
              ? "Live stdout and stderr from the running app container."
              : "Deploy or start the app to stream live container output."
            : "Build output from the most recent deployment."
        }
      />
      <div className="mb-3 flex gap-0.5 rounded-lg border border-border/80 bg-muted/30 p-0.5 w-fit">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "rounded-md",
            view === "runtime" && "bg-background text-foreground shadow-sm"
          )}
          onClick={() => setView("runtime")}
        >
          Runtime
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "rounded-md",
            view === "build" && "bg-background text-foreground shadow-sm"
          )}
          onClick={() => setView("build")}
        >
          Last build
        </Button>
      </div>
      {view === "runtime" ? (
        <RuntimeLogViewer appId={appId} />
      ) : lastDeploymentId ? (
        <BuildLogViewer deploymentId={lastDeploymentId} />
      ) : (
        <p className="text-sm text-muted-foreground">
          No deployments yet. Deploy the app to see build logs.
        </p>
      )}
    </div>
  );
}
