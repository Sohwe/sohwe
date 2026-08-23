import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAppConfig } from "@/lib/config";
import { formatRelativeTime, shortCommitSha, truncMsg } from "@/lib/format";
import type { AppRow } from "@/lib/types";
import { getCurrentDeploymentId } from "@/lib/types";
import { CopyButton } from "@/components/common/CopyButton";

export function AppOverviewPage() {
  const { appId } = useParams({ strict: false });
  const q = useQuery({ queryKey: ["applications"], queryFn: () => api<AppRow[]>("/api/applications") });
  const { baseDomain, httpsEnabled } = useAppConfig();
  const app = q.data?.find((a) => a.id === appId);
  if (!appId || !q.data || !app) return null;

  const scheme = httpsEnabled ? "https" : "http";
  const appUrl = `${scheme}://${app.slug}.${baseDomain}`;
  const appDomainUrl = app.domain ? `${scheme}://${app.domain}` : null;
  const lastDep = app.deployments?.length
    ? [...(app.deployments ?? [])].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0]
    : undefined;
  const currentId = getCurrentDeploymentId(app.deployments);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Service URL</CardTitle>
          <CardDescription>Where traffic is routed (Traefik)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-1">
            <a href={appUrl} className="text-primary hover:underline" target="_blank" rel="noreferrer">
              {appUrl}
            </a>
            <CopyButton text={appUrl} label="Copy" className="h-7 w-7" />
          </div>
          {appDomainUrl ? (
            <p>
              <a className="text-emerald-600 hover:underline dark:text-emerald-400" href={appDomainUrl} target="_blank" rel="noreferrer">
                {appDomainUrl}
                <ExternalLink className="ml-1 inline h-3 w-3" />
              </a>
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resource limits</CardTitle>
          <CardDescription>Applied on next deploy (Docker cgroups)</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>Memory: {app.memoryLimitMb != null ? `${app.memoryLimitMb} MB` : "Unlimited"}</p>
          <p className="mt-1">CPU: {app.cpuLimit != null ? `${app.cpuLimit} cores` : "Unlimited"}</p>
        </CardContent>
      </Card>
      {lastDep ? (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Latest deployment</CardTitle>
            <CardDescription>{formatRelativeTime(lastDep.createdAt)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Status: </span>
              <span className="font-mono">{lastDep.status}</span>
            </p>
            {lastDep.commitSha ? (
              <p>
                <span className="text-muted-foreground">Commit: </span>
                <span className="font-mono">{shortCommitSha(lastDep.commitSha)}</span>{" "}
                {lastDep.commitMessage ? <span>— {truncMsg(lastDep.commitMessage, 120)}</span> : null}
              </p>
            ) : null}
            {currentId === lastDep.id ? <p className="text-xs text-primary">This is the current running image</p> : null}
            <div className="pt-1">
              <Button asChild size="sm" variant="secondary">
                <Link to="/apps/$appId/deployments" params={{ appId: appId }}>
                  View all deployments
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
