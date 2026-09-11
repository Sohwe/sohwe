import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreateProjectSchema, normalizeHostname } from "@sohwe/types";
import { Boxes, Plus, Rocket, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/PageHeader";
import { Field } from "@/components/common/Field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, apiGet, fetchMe } from "@/lib/api";
import { isAdmin } from "@/lib/roles";
import type { Me, ProjectRow } from "@/lib/types";

function CreateProjectDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [port, setPort] = useState(3000);
  const [domain, setDomain] = useState("");
  const [apiTarget, setApiTarget] = useState("api");
  const [workerTarget, setWorkerTarget] = useState("worker");
  const [releaseTarget, setReleaseTarget] = useState("migrate");

  const create = useMutation({
    mutationFn: () => {
      const payload = CreateProjectSchema.parse({
        name,
        slug,
        gitRepo: repo,
        gitBranch: branch,
        services: [
          {
            name: "API",
            slug: "api",
            kind: "http",
            port,
            dockerfilePath: "Dockerfile",
            dockerTarget: apiTarget,
            domains: domain.trim() ? [normalizeHostname(domain)] : []
          },
          {
            name: "Worker",
            slug: "worker",
            kind: "worker",
            dockerfilePath: "Dockerfile",
            dockerTarget: workerTarget
          },
          {
            name: "Database migration",
            slug: "migrate",
            kind: "release",
            restartPolicy: "no",
            dockerfilePath: "Dockerfile",
            dockerTarget: releaseTarget
          }
        ]
      });
      return api<ProjectRow>("/api/projects", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
      toast.success("Project created");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not create project")
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New multi-service project</DialogTitle>
          <DialogDescription>
            FleetOptics preset: one routed API, one private worker, and one migration job from a shared commit.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label="Project slug">
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                pattern="[a-z0-9-]+"
                required
              />
            </Field>
          </div>
          <Field label="Git repository URL">
            <Input value={repo} onChange={(e) => setRepo(e.target.value)} type="url" required />
          </Field>
          <Field label="Branch">
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} required />
          </Field>
          <div className="rounded-md border p-3">
            <p className="mb-3 text-sm font-medium">Root Dockerfile targets</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="API target">
                <Input value={apiTarget} onChange={(e) => setApiTarget(e.target.value)} required />
              </Field>
              <Field label="Worker target">
                <Input value={workerTarget} onChange={(e) => setWorkerTarget(e.target.value)} required />
              </Field>
              <Field label="Migration target">
                <Input value={releaseTarget} onChange={(e) => setReleaseTarget(e.target.value)} required />
              </Field>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="API port">
              <Input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                required
              />
            </Field>
            <Field label="API custom domain (optional)">
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create project"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectLogs({ projectId }: { projectId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const source = new EventSource(`/api/projects/${projectId}/logs?limit=200`);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as {
        type: string;
        logs?: { stream: string; message: string; serviceId: string }[];
        stream?: string;
        message?: string;
        serviceId?: string;
      };
      const next =
        payload.type === "replay"
          ? (payload.logs ?? []).map(
              (line) => `[${line.serviceId.slice(0, 8)} ${line.stream}] ${line.message}`
            )
          : payload.message
            ? [`[${payload.serviceId?.slice(0, 8) ?? "service"} ${payload.stream ?? "stdout"}] ${payload.message}`]
            : [];
      setLines((current) => [...(payload.type === "replay" ? [] : current), ...next].slice(-500));
    };
    return () => source.close();
  }, [projectId]);
  return (
    <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
      {lines.length ? lines.join("\n") : "No service logs yet."}
    </pre>
  );
}

function ProjectCard({ project }: { project: ProjectRow }) {
  const client = useQueryClient();
  const [logs, setLogs] = useState(false);
  const deploy = useMutation({
    mutationFn: () => api(`/api/projects/${project.id}/deploy`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Coordinated release queued");
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Deploy failed")
  });
  const previous = project.releases.find(
    (release) => release.status === "success" && release.id !== project.currentReleaseId
  );
  const rollback = useMutation({
    mutationFn: () =>
      api(`/api/projects/${project.id}/rollback`, {
        method: "POST",
        body: JSON.stringify({ sourceReleaseId: previous?.id })
      }),
    onSuccess: () => toast.success("Coordinated rollback queued"),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Rollback failed")
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{project.name}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {project.repoFullName ?? project.gitRepo} · {project.gitBranch}
            </p>
          </div>
          <Badge variant="outline">{project.status}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {project.services.map((service) => (
            <Badge key={service.id} variant="secondary">
              {service.slug}: {service.kind}
              {service.dockerTarget ? ` / ${service.dockerTarget}` : ""}
            </Badge>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => deploy.mutate()} disabled={deploy.isPending}>
            <Rocket className="mr-2 h-4 w-4" /> Release
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!previous || rollback.isPending}
            onClick={() => rollback.mutate()}
            title="Database migrations remain forward-only"
          >
            <RotateCcw className="mr-2 h-4 w-4" /> Roll back services
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLogs((value) => !value)}>
            {logs ? "Hide logs" : "Service logs"}
          </Button>
        </div>
        {project.releases[0]?.errorMessage ? (
          <p className="mt-3 text-sm text-destructive">{project.releases[0].errorMessage}</p>
        ) : null}
        {logs ? <ProjectLogs projectId={project.id} /> : null}
      </CardContent>
    </Card>
  );
}

export function ProjectsPage() {
  const [open, setOpen] = useState(false);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiGet<ProjectRow[]>("/api/projects"),
    refetchInterval: 5_000
  });
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => fetchMe<Me | null>()
  });
  return (
    <div>
      <PageHeader
        title="Projects"
        description="Release HTTP services, private workers, and one-shot migrations from one commit."
        actions={
          isAdmin(me) ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> New project
            </Button>
          ) : undefined
        }
      />
      <CreateProjectDialog open={open} onOpenChange={setOpen} />
      {projects.isError ? <p className="text-destructive">Could not load projects.</p> : null}
      {projects.data?.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          <Boxes className="mx-auto mb-3 h-8 w-8" />
          No multi-service projects yet.
        </div>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {projects.data?.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </div>
    </div>
  );
}
