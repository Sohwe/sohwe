import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ExternalLink, GitBranch, MoreHorizontal, Rocket } from "lucide-react";
import { toast } from "sonner";
import { BuildModeBadge, AppStatusBadge } from "./BuildModeBadge";
import { useAppConfig } from "@/lib/config";
import { formatRelativeTime, shortCommitSha, truncMsg } from "@/lib/format";
import type { AppRow } from "@/lib/types";
import { getCurrentDeploymentId } from "@/lib/types";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { CopyButton } from "@/components/common/CopyButton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function AppCard({ app }: { app: AppRow }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { baseDomain, httpsEnabled } = useAppConfig();
  const scheme = httpsEnabled ? "https" : "http";
  const appUrl = `${scheme}://${app.slug}.${baseDomain}`;
  const lastDep = app.deployments?.[0]
    ? [...(app.deployments ?? [])].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0]
    : undefined;
  const currentId = getCurrentDeploymentId(app.deployments);

  const deployMut = useMutation({
    mutationFn: (id: string) =>
      api<{ deployment: { id: string } }>(`/api/applications/${id}/deploy`, { method: "POST" }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      void queryClient.invalidateQueries({ queryKey: ["application", app.id] });
      toast.success("Deploy started");
      void navigate({ to: "/apps/$appId/deployments/$deploymentId", params: { appId: app.id, deploymentId: data.deployment.id } });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Deploy failed");
    }
  });

  return (
    <Card className="group transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-border hover:shadow-lg hover:shadow-black/5 dark:hover:shadow-black/20">
      <CardHeader className="border-b border-border/60 pb-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-sm font-semibold uppercase text-foreground">
              {app.name.slice(0, 1)}
            </span>
            <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/apps/$appId/overview"
                params={{ appId: app.id }}
                className="text-base font-semibold tracking-tight text-foreground hover:underline"
              >
                {app.name}
              </Link>
              <BuildModeBadge mode={app.buildMode} />
            </div>
            <div className="mt-1.5">
              <AppStatusBadge status={app.status} />
            </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              disabled={app.status === "deploying" || deployMut.isPending}
              onClick={() => deployMut.mutate(app.id)}
            >
              <Rocket className="mr-1.5 h-3.5 w-3.5" />
              {app.status === "deploying" || deployMut.isPending ? "…" : "Deploy"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="More">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a href={appUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2">
                    <ExternalLink className="h-3.5 w-3.5" /> Open {app.slug}.{baseDomain}
                  </a>
                </DropdownMenuItem>
                {app.domain ? (
                  <DropdownMenuItem asChild>
                    <a href={`${scheme}://${app.domain}`} target="_blank" rel="noreferrer" className="flex items-center gap-2">
                      <ExternalLink className="h-3.5 w-3.5" /> Open {app.domain}
                    </a>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem asChild>
                  <Link to="/apps/$appId/settings" params={{ appId: app.id }} className="w-full">
                    Settings
                  </Link>
                </DropdownMenuItem>
                {app.status === "running" ? (
                  <DropdownMenuItem asChild>
                    <Link to="/apps/$appId/files" params={{ appId: app.id }} className="w-full">
                      Files
                    </Link>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4 text-sm text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a href={appUrl} className="inline-flex items-center gap-1 text-primary hover:underline" target="_blank" rel="noreferrer">
            {app.slug}.{baseDomain}
            <CopyButton text={appUrl} label="Copy URL" className="h-6 w-6 text-muted-foreground" />
          </a>
        </div>
        {app.domain ? (
          <a href={`${scheme}://${app.domain}`} className="mt-1 block text-xs text-emerald-600 hover:underline dark:text-emerald-400" target="_blank" rel="noreferrer">
            {app.domain}
          </a>
        ) : null}
        <div className="mt-3 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono">{app.gitRepo}</span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono">{app.gitBranch}</span>
          <span className="shrink-0 font-mono">:{app.port}</span>
        </div>
        {lastDep ? (
          <div className="mt-4 rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Latest deploy: </span>
            <span className="font-mono text-foreground/90">{lastDep.status}</span>
            {lastDep.commitSha ? (
              <span className="ml-2 font-mono text-muted-foreground">{shortCommitSha(lastDep.commitSha)}</span>
            ) : null}
            {lastDep.commitMessage ? <span className="ml-2">· {truncMsg(lastDep.commitMessage, 48)}</span> : null}
            {currentId === lastDep.id ? <span className="ml-2 text-primary">(current)</span> : null}
            <span className="ml-2 text-muted-foreground">{formatRelativeTime(lastDep.createdAt)}</span>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-4">
          <Button variant="outline" size="sm" asChild>
            <Link to="/apps/$appId/overview" params={{ appId: app.id }}>
              Open
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/apps/$appId/deployments" params={{ appId: app.id }}>
              Deployments
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
