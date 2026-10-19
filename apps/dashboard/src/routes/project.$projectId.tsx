import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, ExternalLink, Rocket } from "lucide-react";
import { toast } from "sonner";
import { api, fetchMe } from "@/lib/api";
import { activeRelease, useProject } from "@/lib/projects";
import { useAppConfig } from "@/lib/config";
import { isAdmin } from "@/lib/roles";
import type { Me } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

const tabs = [
  ["overview", "Overview"],
  ["releases", "Releases"],
  ["logs", "Logs"],
  ["domains", "Domains"],
  ["variables", "Variables"],
  ["datastores", "Datastores"],
  ["settings", "Settings"],
] as const;

export function ProjectLayout() {
  const query = useProject();
  const project = query.data;
  const navigate = useNavigate();
  const client = useQueryClient();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const { httpsEnabled } = useAppConfig();
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => fetchMe<Me | null>(),
  });
  const release = useMutation({
    mutationFn: () =>
      api<{ release: { id: string } }>(`/api/projects/${project!.id}/deploy`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      void client.invalidateQueries({ queryKey: ["project"] });
      void client.invalidateQueries({ queryKey: ["project-releases"] });
      void navigate({
        to: "/projects/$projectId/releases/$releaseId",
        params: { projectId: project!.id, releaseId: data.release.id },
      });
      toast.success("Coordinated release queued");
    },
    onError: (error) => toast.error(error.message),
  });
  if (query.isPending) return <Skeleton className="h-72 w-full" />;
  if (!project)
    return (
      <div role="alert" className="space-y-3">
        <p>Could not load this project.</p>
        <Button onClick={() => void query.refetch()} variant="outline">
          Retry
        </Button>
        <Button asChild variant="link">
          <Link to="/projects">Back to projects</Link>
        </Button>
      </div>
    );
  const domain = project.services.flatMap((service) => service.domains)[0]
    ?.hostname;
  const busy = project.releases.some((item) => activeRelease(item.status));
  const section = path.split("/")[3] ?? "overview";
  return (
    <div>
      <div className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Boxes className="size-6 text-primary" />
            <h1 className="text-xl font-semibold tracking-tight">
              {project.name}
            </h1>
            <Badge variant="outline">{project.status}</Badge>
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {project.repoFullName ?? project.gitRepo} · {project.gitBranch} ·{" "}
            {project.services.length} services
          </p>
          {domain ? (
            <a
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              href={`${httpsEnabled ? "https" : "http"}://${domain}`}
              target="_blank"
              rel="noreferrer"
            >
              {domain}
              <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
        <Button
          disabled={busy || release.isPending}
          onClick={() => release.mutate()}
        >
          <Rocket className="mr-2 size-4" />
          {busy ? "Releasing…" : "Release"}
        </Button>
      </div>
      <nav
        aria-label="Project sections"
        className="mb-7 flex gap-1 overflow-x-auto border-b"
      >
        {tabs
          .filter(
            ([tab]) =>
              isAdmin(me) ||
              !["variables", "datastores", "settings"].includes(tab),
          )
          .map(([tab, label]) => (
            <Button
              key={tab}
              asChild
              variant="ghost"
              size="sm"
              className={`h-10 shrink-0 rounded-none border-b-2 px-3 ${section === tab ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
            >
              <Link
                to={`/projects/$projectId/${tab}`}
                params={{ projectId: project.id }}
                aria-current={section === tab ? "page" : undefined}
              >
                {label}
              </Link>
            </Button>
          ))}
      </nav>
      <Outlet />
    </div>
  );
}
