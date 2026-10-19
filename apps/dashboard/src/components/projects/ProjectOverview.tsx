import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { ProjectRelease } from "@/lib/types";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Globe, Terminal, Workflow } from "lucide-react";
import { useProject, projectServiceHost } from "@/lib/projects";
import { useAppConfig } from "@/lib/config";
import { formatRelativeTime, shortCommitSha } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/common/CopyButton";

export function ProjectOverviewPage() {
  const { data: project } = useProject();
  const { baseDomain, httpsEnabled } = useAppConfig();
  const currentInWindow = project?.releases.find(
    (release) => release.id === project.currentReleaseId,
  );
  const currentQuery = useQuery({
    queryKey: [
      "project-release-summary",
      project?.id,
      project?.currentReleaseId,
    ],
    queryFn: () =>
      apiGet<ProjectRelease>(
        `/api/projects/${project!.id}/releases/${project!.currentReleaseId}`,
      ),
    enabled: Boolean(project?.currentReleaseId && !currentInWindow),
  });
  if (!project) return null;
  const latest = project.releases[0];
  const current = currentInWindow ?? currentQuery.data;
  const scheme = httpsEnabled ? "https" : "http";
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Current release</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {current ? (
              <>
                <Badge variant="outline">Live</Badge>
                <p className="font-mono">{shortCommitSha(current.commitSha)}</p>
                <p className="text-muted-foreground">
                  {current.commitMessage || "No commit message"}
                </p>
                <Button asChild variant="link" className="h-auto p-0">
                  <Link
                    to="/projects/$projectId/releases/$releaseId"
                    params={{ projectId: project.id, releaseId: current.id }}
                  >
                    View release
                  </Link>
                </Button>
              </>
            ) : project.currentReleaseId ? (
              currentQuery.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  Could not load the current release.{" "}
                  <button className="underline" onClick={() => void currentQuery.refetch()}>
                    Retry
                  </button>
                </p>
              ) : (
                <p role="status" className="text-muted-foreground">Loading current release…</p>
              )
            ) : (
              <p className="text-muted-foreground">
                No release is live yet. Configure services, variables and
                datastores before releasing.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Latest attempt</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {latest ? (
              <>
                <Badge variant="outline">{latest.status}</Badge>
                <p>
                  {formatRelativeTime(latest.createdAt)} · {latest.trigger}
                </p>
                {latest.errorMessage ? (
                  <p className="text-destructive">{latest.errorMessage}</p>
                ) : (
                  <p className="text-muted-foreground">
                    {latest.commitMessage ||
                      "Services are released together from the same commit."}
                  </p>
                )}
                <Button asChild variant="link" className="h-auto p-0">
                  <Link
                    to="/projects/$projectId/releases/$releaseId"
                    params={{ projectId: project.id, releaseId: latest.id }}
                  >
                    View details and build logs
                  </Link>
                </Button>
              </>
            ) : (
              <p className="text-muted-foreground">No release attempts yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
      <div>
        <h2 className="mb-3 text-base font-semibold">Services</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {project.services.map((service) => {
            const host = projectServiceHost(
              project.slug,
              service.slug,
              baseDomain,
            );
            const deployment = (current ?? latest)?.serviceDeployments.find(
              (item) => item.serviceId === service.id,
            );
            return (
              <Card key={service.id}>
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {service.kind === "http" ? (
                      <Globe className="size-4 text-primary" />
                    ) : service.kind === "release" ? (
                      <Workflow className="size-4 text-primary" />
                    ) : (
                      <Terminal className="size-4 text-primary" />
                    )}
                    {service.name}
                    <Badge variant="secondary">{service.kind}</Badge>
                    <Badge variant="outline">
                      {deployment?.status ?? "not deployed"}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {service.kind === "http" ? (
                    <div className="space-y-1">
                      {[
                        host,
                        ...service.domains.map((domain) => domain.hostname),
                      ].map((domain) => (
                        <div
                          key={domain}
                          className="flex min-w-0 items-center gap-1"
                        >
                          <a
                            href={`${scheme}://${domain}`}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate text-primary hover:underline"
                          >
                            {domain}
                          </a>
                          <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                          <CopyButton
                            text={`${scheme}://${domain}`}
                            label="Copy URL"
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground">
                      {service.kind === "release"
                        ? "Runs once before runtime services start."
                        : `Private service · reachable inside the project as ${service.slug}`}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {service.buildMode} · {service.serviceDirectory}
                    {service.dockerTarget
                      ? ` · target ${service.dockerTarget}`
                      : ""}
                    {service.port ? ` · port ${service.port}` : ""}
                  </p>
                  {service.dependencies.length ? (
                    <p className="text-xs text-muted-foreground">
                      Waits for{" "}
                      {service.dependencies
                        .map(
                          (dep) =>
                            `${dep.dependencyService.name} (${dep.condition})`,
                        )
                        .join(", ")}
                    </p>
                  ) : null}
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to="/projects/$projectId/logs"
                      params={{ projectId: project.id }}
                      search={{ serviceId: service.id }}
                    >
                      View service logs
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
