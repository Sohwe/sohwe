import { useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api, apiGet, fetchMe } from "@/lib/api";
import { activeRelease, useProject } from "@/lib/projects";
import { isAdmin } from "@/lib/roles";
import type { Me, ProjectRelease } from "@/lib/types";
import { formatDateTime, formatDuration, shortCommitSha } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/common/StatusBadge";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { LogPane } from "@/components/apps/LogPane";

export function ProjectReleasesPage() {
  const { projectId } = useParams({ strict: false });
  const { data: project } = useProject();
  const query = useInfiniteQuery({
    queryKey: ["project-releases", projectId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiGet<{ releases: ProjectRelease[]; nextCursor: string | null }>(
        `/api/projects/${projectId}/releases?${new URLSearchParams({ limit: "20", ...(pageParam ? { cursor: pageParam } : {}) })}`,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: project?.releases.some((item) =>
      activeRelease(item.status),
    )
      ? 2_000
      : false,
  });
  if (!project) return null;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Release history</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Builds, one-shot jobs, service readiness and coordinated rollbacks.
        </p>
      </div>
      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load releases.{" "}
          <button className="underline" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {query.isPending ? <p role="status">Loading releases…</p> : null}
      {query.data?.pages
        .flatMap((page) => page.releases)
        .map((release) => (
          <Link
            key={release.id}
            to="/projects/$projectId/releases/$releaseId"
            params={{ projectId: project.id, releaseId: release.id }}
            className="block rounded-xl border bg-card p-5 transition-colors hover:border-primary/50"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={release.status} />
                <span className="font-mono text-xs">
                  {shortCommitSha(release.commitSha)}
                </span>
                {project.currentReleaseId === release.id ? (
                  <Badge variant="success">Current</Badge>
                ) : null}
                <Badge variant="secondary">{release.trigger}</Badge>
              </div>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(release.createdAt)} ·{" "}
                {formatDuration(release.startedAt, release.finishedAt)}
              </span>
            </div>
            <p className="mt-3 truncate text-sm">
              {release.commitMessage || `Release ${release.id.slice(0, 8)}`}
            </p>
            {release.errorMessage ? (
              <p className="mt-2 text-sm text-destructive">
                {release.errorMessage}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {release.serviceDeployments.map((item) => (
                <span key={item.id} className="text-xs text-muted-foreground">
                  {item.service.name}: {item.status}
                </span>
              ))}
            </div>
          </Link>
        ))}
      {query.data?.pages[0]?.releases.length === 0 ? (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground">
          No release attempts yet.
        </p>
      ) : null}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load older releases"}
        </Button>
      ) : null}
    </div>
  );
}

function BuildLogs({
  projectId,
  releaseId,
  serviceId,
  active,
}: {
  projectId: string;
  releaseId: string;
  serviceId: string;
  active: boolean;
}) {
  const query = useQuery({
    queryKey: ["project-build-logs", releaseId, serviceId],
    queryFn: () =>
      apiGet<{ buildLogs: string | null }>(
        `/api/projects/${projectId}/releases/${releaseId}/services/${serviceId}/build-logs`,
      ),
    refetchInterval: active ? 2_000 : false,
  });
  const [search, setSearch] = useState("");
  const text = query.data?.buildLogs ?? "";
  const filtered = search
    ? text
        .split("\n")
        .filter((line) => line.toLowerCase().includes(search.toLowerCase()))
        .join("\n")
    : text;
  return (
    <div className="space-y-3">
      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load build logs.{" "}
          <button className="underline" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      <input
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        aria-label="Search build logs"
        placeholder="Search build logs"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <LogPane
        className="h-[min(65vh,650px)]"
        text={filtered}
        emptyText={
          query.isPending
            ? "Loading build output…"
            : query.isError
              ? "Build output could not be loaded."
              : search
                ? "No matching lines."
                : active
                  ? "Waiting for build output…"
                  : "No build output recorded."
        }
        downloadName={`sohwe-build-${releaseId}-${serviceId}.log`}
        toolbarLeft={
          <span>
            {active ? "Following build output" : "Retained build output"}
          </span>
        }
      />
    </div>
  );
}

export function ProjectReleasePage() {
  const { releaseId } = useParams({ strict: false });
  const { data: project } = useProject();
  const client = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => fetchMe<Me | null>(),
  });
  const [serviceId, setServiceId] = useState("");
  const [confirm, setConfirm] = useState(false);
  const query = useQuery({
    queryKey: ["project-release-summary", project?.id, releaseId],
    queryFn: () =>
      apiGet<ProjectRelease>(
        `/api/projects/${project!.id}/releases/${releaseId}`,
      ),
    enabled: Boolean(project && releaseId),
    refetchInterval: (query) =>
      query.state.data && activeRelease(query.state.data.status)
        ? 2_000
        : false,
  });
  const rollback = useMutation({
    mutationFn: () =>
      api<{ release: { id: string } }>(
        `/api/projects/${project!.id}/rollback`,
        {
          method: "POST",
          body: JSON.stringify({ sourceReleaseId: releaseId }),
        },
      ),
    onSuccess: (data) => {
      void client.invalidateQueries({ queryKey: ["project"] });
      void client.invalidateQueries({ queryKey: ["project-releases"] });
      void navigate({
        to: "/projects/$projectId/releases/$releaseId",
        params: { projectId: project!.id, releaseId: data.release.id },
      });
      toast.success("Coordinated rollback queued");
    },
    onError: (error) => toast.error(error.message),
  });
  if (!project) return null;
  if (query.isPending) return <p role="status">Loading release…</p>;
  if (!query.data)
    return (
      <p role="alert">
        Could not load this release.{" "}
        <button className="underline" onClick={() => void query.refetch()}>
          Retry
        </button>
      </p>
    );
  const release = query.data;
  const selected =
    release.serviceDeployments.find((item) => item.serviceId === serviceId) ??
    release.serviceDeployments[0];
  const busy = project.releases.some((item) => activeRelease(item.status));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Button asChild variant="link" className="h-auto p-0">
            <Link
              to="/projects/$projectId/releases"
              params={{ projectId: project.id }}
            >
              ← Release history
            </Link>
          </Button>
          <h2 className="text-lg font-semibold">
            Release <span className="font-mono">{release.id.slice(0, 8)}</span>
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={release.status} />
            <span className="text-xs text-muted-foreground">
              {shortCommitSha(release.commitSha)} · {release.trigger} ·{" "}
              {formatDateTime(release.createdAt)} ·{" "}
              {formatDuration(release.startedAt, release.finishedAt)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {release.commitMessage}
          </p>
        </div>
        {release.status === "success" &&
        release.id !== project.currentReleaseId ? (
          <Button
            variant="outline"
            disabled={busy || rollback.isPending}
            onClick={() => setConfirm(true)}
          >
            Roll back to this release
          </Button>
        ) : null}
      </div>
      {release.errorMessage ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {release.errorMessage}
        </div>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Service results</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {release.serviceDeployments.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {item.service.name}
                  </span>
                  <Badge variant="secondary">{item.service.kind}</Badge>
                  <StatusBadge status={item.status} />
                </div>
                {item.errorMessage ? (
                  <p className="mt-1 text-sm text-destructive">
                    {item.errorMessage}
                  </p>
                ) : null}
                {item.exitCode !== null ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Exit code {item.exitCode}
                  </p>
                ) : null}
              </div>
              <Button asChild size="sm" variant="outline">
                <Link
                  to="/projects/$projectId/logs"
                  params={{ projectId: project.id }}
                  search={{ releaseId: release.id, serviceId: item.serviceId }}
                >
                  {item.service.kind === "release"
                    ? "View job output"
                    : "View runtime logs"}
                </Link>
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
      {isAdmin(me) && selected ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-semibold">Build logs</h3>
            <select
              aria-label="Build log service"
              className="h-9 max-w-full rounded-md border bg-background px-3 text-sm"
              value={selected.serviceId}
              onChange={(event) => setServiceId(event.target.value)}
            >
              {release.serviceDeployments.map((item) => (
                <option key={item.id} value={item.serviceId}>
                  {item.service.name} · {item.status}
                </option>
              ))}
            </select>
          </div>
          <BuildLogs
            key={`${release.id}-${selected.serviceId}`}
            projectId={project.id}
            releaseId={release.id}
            serviceId={selected.serviceId}
            active={activeRelease(release.status)}
          />
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          Build output is available to owners and admins. Service runtime and
          job logs are available from the service results above.
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Roll back project services"
        description="Reuse every service image from this successful release. Database migrations remain forward-only and are not reversed."
        confirmLabel="Roll back services"
        onConfirm={() => rollback.mutate()}
      />
    </div>
  );
}
