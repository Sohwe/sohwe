import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { Rocket, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { AppStatusBadge, BuildModeBadge } from "@/components/apps/BuildModeBadge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, fetchMe } from "@/lib/api";
import { useAppConfig } from "@/lib/config";
import { isAdmin } from "@/lib/roles";
import type { AppRow, Me } from "@/lib/types";
import { CopyButton } from "@/components/common/CopyButton";
import { Skeleton } from "@/components/ui/skeleton";

type TabDef = {
  path:
    | "overview"
    | "deployments"
    | "logs"
    | "metrics"
    | "variables"
    | "volumes"
    | "domains"
    | "files"
    | "settings";
  label: string;
  route:
    | "/apps/$appId/overview"
    | "/apps/$appId/deployments"
    | "/apps/$appId/logs"
    | "/apps/$appId/metrics"
    | "/apps/$appId/variables"
    | "/apps/$appId/volumes"
    | "/apps/$appId/domains"
    | "/apps/$appId/files"
    | "/apps/$appId/settings";
};

const tabs: TabDef[] = [
  { path: "overview", label: "Overview", route: "/apps/$appId/overview" },
  { path: "deployments", label: "Deployments", route: "/apps/$appId/deployments" },
  { path: "logs", label: "Logs", route: "/apps/$appId/logs" },
  { path: "metrics", label: "Metrics", route: "/apps/$appId/metrics" },
  { path: "variables", label: "Variables", route: "/apps/$appId/variables" },
  { path: "volumes", label: "Volumes", route: "/apps/$appId/volumes" },
  { path: "domains", label: "Domains", route: "/apps/$appId/domains" },
  { path: "files", label: "Files", route: "/apps/$appId/files" },
  { path: "settings", label: "Settings", route: "/apps/$appId/settings" }
];

/** Tabs backed by admin-only endpoints; a member would only get a 403 there. */
const ADMIN_TABS = new Set<TabDef["path"]>(["variables", "files", "settings"]);

export function AppLayout() {
  const { appId } = useParams({ strict: false });
  if (!appId) throw new Error("appId");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { baseDomain, httpsEnabled } = useAppConfig();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() });
  const visibleTabs = isAdmin(me) ? tabs : tabs.filter((t) => !ADMIN_TABS.has(t.path));

  const appsQuery = useQuery({
    queryKey: ["applications"],
    queryFn: () => api<AppRow[]>("/api/applications"),
    refetchInterval: (q) => {
      const list = q.state.data;
      const a = list?.find((x) => x.id === appId);
      if (!a) return false;
      if (a.status === "deploying") return 2000;
      const active = a.deployments?.find(
        (d) => d.id && (d.status === "pending" || d.status === "building")
      );
      return active ? 2000 : false;
    }
  });
  const app = appsQuery.data?.find((a) => a.id === appId);

  const deployMut = useMutation({
    mutationFn: (id: string) =>
      api<{ deployment: { id: string } }>(`/api/applications/${id}/deploy`, { method: "POST" }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      toast.success("Deploy started");
      void navigate({
        to: "/apps/$appId/deployments/$deploymentId",
        params: { appId, deploymentId: data.deployment.id }
      });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Deploy failed");
    }
  });

  const currentSection = useMemo(() => {
    const parts = pathname.split("/").filter(Boolean);
    return parts[2] ?? "overview";
  }, [pathname]);

  if (appsQuery.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-9 w-full max-w-2xl" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (appsQuery.isError || !app) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-sm">
        <p className="font-medium text-destructive">Application not found</p>
        <Button asChild variant="link" className="mt-2 p-0">
          <Link to="/apps">Back to applications</Link>
        </Button>
      </div>
    );
  }

  const scheme = httpsEnabled ? "https" : "http";
  const appUrl = `${scheme}://${app.slug}.${baseDomain}`;

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{app.name}</h1>
            <BuildModeBadge mode={app.buildMode} />
            <AppStatusBadge status={app.status} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <a href={appUrl} className="inline-flex items-center gap-1 text-primary hover:underline" target="_blank" rel="noreferrer">
              {app.slug}.{baseDomain}
              <ExternalLink className="h-3 w-3" />
            </a>
            <CopyButton text={appUrl} label="Copy URL" className="h-6 w-6 text-muted-foreground" />
            {app.domain ? (
              <a
                className="text-emerald-600 hover:underline dark:text-emerald-400"
                href={`${scheme}://${app.domain}`}
                target="_blank"
                rel="noreferrer"
              >
                {app.domain}
              </a>
            ) : null}
          </div>
        </div>
        <Button
          size="sm"
          disabled={app.status === "deploying" || deployMut.isPending}
          onClick={() => deployMut.mutate(app.id)}
        >
          <Rocket className="mr-2 h-4 w-4" />
          {app.status === "deploying" || deployMut.isPending ? "…" : "Deploy"}
        </Button>
      </div>

      <div className="mb-6 flex flex-wrap gap-0.5 rounded-lg border border-border/80 bg-muted/30 p-0.5">
        {visibleTabs.map((t) => {
          const isActive = t.path === "deployments" ? currentSection === "deployments" : currentSection === t.path;
          if (t.path === "files" && app.status !== "running") {
            return (
              <Button
                key={t.path}
                variant="ghost"
                size="sm"
                className="rounded-md opacity-50"
                type="button"
                disabled
                title="App must be running to browse the filesystem"
              >
                {t.label}
              </Button>
            );
          }
          return (
            <Button
              key={t.path}
              variant="ghost"
              size="sm"
              className={cn("rounded-md", isActive && "bg-background text-foreground shadow-sm")}
              asChild
            >
              <Link to={t.route} params={{ appId }}>
                {t.label}
              </Link>
            </Button>
          );
        })}
      </div>
      <Outlet />
    </div>
  );
}
