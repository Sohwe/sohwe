import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api, fetchMe } from "@/lib/api";
import { isAdmin } from "@/lib/roles";
import { useAppConfig } from "@/lib/config";
import { formatRelativeTime, shortCommitSha, truncMsg } from "@/lib/format";
import type { AppRow, Me } from "@/lib/types";
import { getCurrentDeploymentId } from "@/lib/types";
import { CopyButton } from "@/components/common/CopyButton";
import { CreatePreviewDialog } from "@/components/apps/CreatePreviewDialog";

export function AppOverviewPage() {
  const { appId } = useParams({ strict: false });
  const q = useQuery({ queryKey: ["applications"], queryFn: () => api<AppRow[]>("/api/applications") });
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() });
  const [previewOpen, setPreviewOpen] = useState(false);
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
  const previews = q.data.filter((candidate) => candidate.previewOfId === app.id);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {app.previewOfId ? <Card className="md:col-span-2"><CardContent className="pt-5 text-sm">This is an isolated preview. Runtime and build variable values from the source app were not copied. <Link className="text-primary underline" to="/apps/$appId/overview" params={{ appId: app.previewOfId }}>Open source app</Link></CardContent></Card> : null}
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
      {!app.imageRef && !app.previewOfId ? <Card className="md:col-span-2"><CardHeader><CardTitle className="text-base">Branch previews</CardTitle><CardDescription>Deploy another branch at its own URL without replacing this application. Add its variable values separately.</CardDescription></CardHeader><CardContent className="space-y-3 text-sm">{isAdmin(me) ? <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)}>Create preview</Button> : null}{previews.length ? <ul className="space-y-2">{previews.map((preview) => <li key={preview.id}><Link className="text-primary underline" to="/apps/$appId/overview" params={{ appId: preview.id }}>{preview.gitBranch}</Link> · {preview.status} · {scheme}://{preview.slug}.{baseDomain}</li>)}</ul> : <p className="text-muted-foreground">No previews yet.</p>}</CardContent></Card> : null}
      {previewOpen ? <CreatePreviewDialog parent={app} open={previewOpen} onOpenChange={setPreviewOpen} /> : null}
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
