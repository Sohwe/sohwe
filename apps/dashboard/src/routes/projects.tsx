import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreateProjectSchema, normalizeHostname, type VariableEntry } from "@sohwe/types";
import { Boxes, FileJson, Plus, Rocket, RotateCcw, Settings, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { EditProjectDialog } from "@/components/projects/EditProjectDialog";
import { ServiceVariableDraftEditor } from "@/components/projects/ServiceVariableDraftEditor";
import { splitServiceVariables } from "@/components/projects/service-variables";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { api, apiGet, fetchMe } from "@/lib/api";
import { isAdmin } from "@/lib/roles";
import type { Me, ProjectRow, RepositoryInspection, RepositoryInspectionCandidate } from "@/lib/types";

type ServiceDraft = {
  key: string;
  name: string;
  slug: string;
  kind: "http" | "worker" | "release";
  buildMode: "auto" | "dockerfile" | "nixpacks";
  serviceDirectory: string;
  workspaceSelector: string;
  dockerfilePath: string;
  dockerTarget: string;
  imageGroup: string;
  buildCmd: string;
  startCmd: string;
  runtimeCmd: string;
  port: string;
  domains: string;
  memoryLimitMb: string;
  cpuLimit: string;
  restartPolicy: "no" | "on-failure" | "unless-stopped" | "always";
  startedDependencies: string;
  healthyDependencies: string;
  healthCheckCmd: string;
  healthCheckIntervalSeconds: string;
  healthCheckTimeoutSeconds: string;
  healthCheckRetries: string;
  healthCheckStartPeriodSeconds: string;
  variables: VariableEntry[];
};

const PROJECT_JSON_TEMPLATE = JSON.stringify(
  {
    name: "My monorepo",
    slug: "my-monorepo",
    gitRepo: "https://github.com/your-org/your-repo.git",
    gitBranch: "main",
    autoDeploy: false,
    envVars: { NODE_ENV: "production" },
    services: [
      {
        name: "API",
        slug: "api",
        kind: "http",
        buildMode: "nixpacks",
        serviceDirectory: "apps/api",
        workspaceSelector: "@your-org/api",
        dockerfilePath: "Dockerfile",
        buildCmd: "pnpm --filter @your-org/api build",
        runtimeCmd: "pnpm --filter @your-org/api start",
        port: 3000,
        domains: [],
        dependsOn: [],
        envVars: {},
        buildArgs: {}
      }
    ]
  },
  null,
  2
);

let nextServiceKey = 0;

function makeServiceDraft(
  kind: ServiceDraft["kind"] = "http",
  ordinal = 1
): ServiceDraft {
  nextServiceKey += 1;
  const suffix = ordinal === 1 ? "" : `-${ordinal}`;
  return {
    key: `service-${Date.now()}-${nextServiceKey}`,
    name: kind === "http" ? `Web${suffix}` : kind === "worker" ? `Worker${suffix}` : "Release",
    slug: kind === "http" ? `web${suffix}` : kind === "worker" ? `worker${suffix}` : "release",
    kind,
    buildMode: "auto",
    serviceDirectory: ".",
    workspaceSelector: "",
    dockerfilePath: "Dockerfile",
    dockerTarget: "",
    imageGroup: "",
    buildCmd: "",
    startCmd: "",
    runtimeCmd: "",
    port: kind === "http" ? "3000" : "",
    domains: "",
    memoryLimitMb: "",
    cpuLimit: "",
    restartPolicy: kind === "release" ? "no" : "unless-stopped",
    startedDependencies: "",
    healthyDependencies: "",
    healthCheckCmd: "",
    healthCheckIntervalSeconds: "10",
    healthCheckTimeoutSeconds: "5",
    healthCheckRetries: "3",
    healthCheckStartPeriodSeconds: "2",
    variables: []
  };
}

function suggestedProjectName(repo: string): string {
  try {
    const url = new URL(repo.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "";
    const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "").replace(/\.git$/i, "");
    return name === "." || name === ".." ? "" : name;
  } catch {
    return "";
  }
}

function suggestedProjectSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
}

function candidateName(candidate: RepositoryInspectionCandidate): string {
  const raw = candidate.directory === "." ? "Web" : candidate.directory.split("/").at(-1) ?? "Web";
  return raw.slice(0, 1).toUpperCase() + raw.slice(1);
}

function availableServiceSlug(name: string, services: ServiceDraft[], exceptKey?: string): string {
  const base = suggestedProjectSlug(name).slice(0, 42) || "service";
  const used = new Set(services.filter((service) => service.key !== exceptKey).map((service) => service.slug));
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function candidateSettings(candidate: RepositoryInspectionCandidate): Partial<ServiceDraft> {
  return {
    buildMode: candidate.buildMode,
    serviceDirectory: candidate.directory,
    dockerfilePath: candidate.dockerfilePath,
    buildCmd: candidate.buildCmd ?? "",
    startCmd: candidate.startCmd ?? "",
    runtimeCmd: candidate.runtimeCmd ?? "",
    port: String(candidate.port)
  };
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalNumber(value: string): number | undefined {
  return value.trim() ? Number(value) : undefined;
}

function commaSeparated(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function variableLines(value: string): Record<string, string> {
  const vars: Record<string, string> = Object.create(null);
  value.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const separator = line.indexOf("=");
    if (separator < 1) {
      throw new Error(`Variable line ${index + 1} must use KEY=value`);
    }
    const key = line.slice(0, separator).trim();
    vars[key] = line.slice(separator + 1);
  });
  return vars;
}

function projectConfigError(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues?: unknown }).issues;
    if (Array.isArray(issues)) {
      const messages = issues.slice(0, 4).flatMap((issue) => {
        if (!issue || typeof issue !== "object" || !("message" in issue)) return [];
        const message = String((issue as { message: unknown }).message);
        const rawPath = "path" in issue ? (issue as { path?: unknown }).path : undefined;
        const path = Array.isArray(rawPath) ? rawPath.map(String).join(".") : "";
        return [path ? `${path}: ${message}` : message];
      });
      if (messages.length > 0) return messages.join("; ");
    }
  }
  return error instanceof Error ? error.message : "Invalid project configuration";
}

function serviceInput(service: ServiceDraft) {
  const healthyDependencies = commaSeparated(service.healthyDependencies);
  const startedDependencies = commaSeparated(service.startedDependencies).filter(
    (slug) => !healthyDependencies.includes(slug)
  );
  return {
    name: service.name,
    slug: service.slug,
    kind: service.kind,
    buildMode: service.buildMode,
    serviceDirectory: service.serviceDirectory,
    workspaceSelector: optionalText(service.workspaceSelector),
    dockerfilePath: service.dockerfilePath,
    dockerTarget: optionalText(service.dockerTarget),
    imageGroup: optionalText(service.imageGroup),
    buildCmd: optionalText(service.buildCmd),
    startCmd: optionalText(service.startCmd),
    runtimeCmd: optionalText(service.runtimeCmd),
    port: service.kind === "http" ? optionalNumber(service.port) : undefined,
    domains:
      service.kind === "http"
        ? commaSeparated(service.domains).map(normalizeHostname)
        : [],
    memoryLimitMb: optionalNumber(service.memoryLimitMb),
    cpuLimit: optionalNumber(service.cpuLimit),
    restartPolicy: service.kind === "release" ? "no" : service.restartPolicy,
    dependsOn:
      service.kind === "release"
        ? []
        : [
            ...startedDependencies.map((serviceSlug) => ({
              serviceSlug,
              condition: "started" as const
            })),
            ...healthyDependencies.map((serviceSlug) => ({
              serviceSlug,
              condition: "healthy" as const
            }))
          ],
    healthCheckCmd: optionalText(service.healthCheckCmd),
    healthCheckIntervalSeconds: optionalNumber(service.healthCheckIntervalSeconds),
    healthCheckTimeoutSeconds: optionalNumber(service.healthCheckTimeoutSeconds),
    healthCheckRetries: optionalNumber(service.healthCheckRetries),
    healthCheckStartPeriodSeconds: optionalNumber(
      service.healthCheckStartPeriodSeconds
    ),
    ...splitServiceVariables(service.variables)
  };
}

function CreateProjectDialog({
  open,
  onOpenChange,
  onReleased
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReleased: (projectId: string) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [autoDeploy, setAutoDeploy] = useState(false);
  const [projectVariables, setProjectVariables] = useState("");
  const [services, setServices] = useState<ServiceDraft[]>(() => [makeServiceDraft()]);
  const [inputMode, setInputMode] = useState<"form" | "json">("form");
  const [jsonConfig, setJsonConfig] = useState(PROJECT_JSON_TEMPLATE);
  const [inspectionRequested, setInspectionRequested] = useState(false);
  const [savedProject, setSavedProject] = useState<ProjectRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jsonFileInput = useRef<HTMLInputElement>(null);

  function resetForm() {
    setName("");
    setSlug("");
    setNameEdited(false);
    setSlugEdited(false);
    setRepo("");
    setBranch("main");
    setAutoDeploy(false);
    setProjectVariables("");
    setServices([makeServiceDraft()]);
    setInputMode("form");
    setJsonConfig(PROJECT_JSON_TEMPLATE);
    setInspectionRequested(false);
    setSavedProject(null);
    setError(null);
  }

  function closeDialog() {
    resetForm();
    onOpenChange(false);
  }

  function updateService(key: string, patch: Partial<ServiceDraft>) {
    setServices((current) =>
      current.map((service) => (service.key === key ? { ...service, ...patch } : service))
    );
  }

  function addService(kind: ServiceDraft["kind"]) {
    setServices((current) => [
      ...current,
      makeServiceDraft(kind, current.filter((service) => service.kind === kind).length + 1)
    ]);
  }

  function applyCandidate(candidate: RepositoryInspectionCandidate, action: "first" | "http" | "worker") {
    setServices((current) => {
      if (action === "first") {
        const first = current[0];
        if (!first) return current;
        const name = first.name === "Web" ? candidateName(candidate) : first.name;
        return current.map((service, index) => index === 0 ? {
          ...service,
          ...candidateSettings(candidate),
          name,
          slug: first.slug === "web" ? availableServiceSlug(name, current, first.key) : first.slug,
          port: first.kind === "http" ? String(candidate.port) : ""
        } : service);
      }
      const name = candidateName(candidate);
      const draft = makeServiceDraft(action);
      return [...current, {
        ...draft,
        ...candidateSettings(candidate),
        name,
        slug: availableServiceSlug(name, current),
        port: action === "http" ? String(candidate.port) : ""
      }];
    });
  }

  const inspection = useQuery({
    queryKey: ["project-repository-inspection", repo.trim(), branch.trim()],
    queryFn: () => api<RepositoryInspection>("/api/repositories/inspect", {
      method: "POST",
      body: JSON.stringify({ gitRepo: repo.trim(), branch: branch.trim() })
    }),
    enabled: open && inspectionRequested && !!repo.trim() && !!branch.trim() && !savedProject,
    retry: false,
    staleTime: 60_000
  });

  const release = useMutation({
    mutationFn: (project: ProjectRow) => api(`/api/projects/${project.id}/deploy`, { method: "POST" }),
    onSuccess: (_result, project) => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      onReleased(project.id);
      closeDialog();
      toast.success("First project release queued");
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not start the first release")
  });

  const create = useMutation({
    mutationFn: async (intent: "release" | "save") => {
      const payload = CreateProjectSchema.parse(
        inputMode === "json"
          ? (JSON.parse(jsonConfig) as unknown)
          : {
              name,
              slug,
              gitRepo: repo,
              gitBranch: branch,
              autoDeploy,
              envVars: variableLines(projectVariables),
              services: services.map(serviceInput)
            }
      );
      const project = await api<ProjectRow>("/api/projects", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      return { project, intent };
    },
    onSuccess: ({ project, intent }) => {
      setSavedProject(project);
      void client.invalidateQueries({ queryKey: ["projects"] });
      if (intent === "release") release.mutate(project);
      else {
        closeDialog();
        toast.success("Project saved as a draft");
      }
    },
    onError: (cause) => setError(projectConfigError(cause))
  });

  const pending = create.isPending || release.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending && !next) closeDialog(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Start with a repository and the services it runs. You can refine build, health, and resource settings later.
          </DialogDescription>
        </DialogHeader>
        {savedProject ? (
          <div className="space-y-3 text-sm">
            <p><strong>{savedProject.name}</strong> was created. Its services and variables are saved.</p>
            {error ? <p className="text-destructive" role="alert">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={pending} onClick={() => { setError(null); release.mutate(savedProject); }}>
                {release.isPending ? "Starting release…" : "Retry release"}
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={closeDialog}>View project</Button>
            </div>
          </div>
        ) : <>
        <div className="flex w-fit rounded-md border p-1">
          <Button
            type="button"
            size="sm"
            variant={inputMode === "form" ? "secondary" : "ghost"}
            onClick={() => setInputMode("form")}
          >
            Form
          </Button>
          <Button
            type="button"
            size="sm"
            variant={inputMode === "json" ? "secondary" : "ghost"}
            onClick={() => setInputMode("json")}
          >
            <FileJson className="mr-1 h-4 w-4" /> JSON
          </Button>
        </div>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            create.mutate(submitter?.value === "save" ? "save" : "release");
          }}
        >
          {inputMode === "form" ? (
            <>
          <Field label="Git repository URL">
            <Input value={repo} onChange={(event) => {
              const next = event.target.value;
              setRepo(next);
              setInspectionRequested(false);
              const suggestedName = suggestedProjectName(next);
              if (!nameEdited) setName(suggestedName);
              if (!slugEdited) setSlug(suggestedProjectSlug(suggestedName));
            }} type="url" placeholder="https://github.com/org/repository" required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project name">
              <Input value={name} onChange={(e) => { setNameEdited(true); setName(e.target.value); }} required />
            </Field>
            <Field label="Project slug">
              <Input
                value={slug}
                onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.toLowerCase()); }}
                pattern="[a-z0-9-]+"
                required
              />
            </Field>
          </div>
          <Field label="Branch">
            <Input value={branch} onChange={(e) => { setBranch(e.target.value); setInspectionRequested(false); }} required />
          </Field>
          <div className="space-y-2 rounded-md border border-border/70 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Find services in this repository</p>
                <p className="text-xs text-muted-foreground">Inspect the branch to suggest directories, builders, commands, and ports.</p>
              </div>
              <Button type="button" size="sm" variant="outline" disabled={!suggestedProjectName(repo) || !branch.trim() || inspection.isFetching} onClick={() => { if (inspection.data) void inspection.refetch(); else setInspectionRequested(true); }}>
                {inspection.isFetching ? "Inspecting…" : inspection.data ? "Inspect again" : "Inspect repository"}
              </Button>
            </div>
            {inspection.isError ? <p className="text-xs text-destructive" role="alert">{projectConfigError(inspection.error)}</p> : null}
            {inspection.data ? <>
              <p className="text-xs text-muted-foreground">Found {inspection.data.candidates.length} candidate{inspection.data.candidates.length === 1 ? "" : "s"} at commit {inspection.data.commitSha.slice(0, 12)}. Choose only the processes this project needs, then review their settings.</p>
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {inspection.data.candidates.map((candidate) => (
                  <div key={candidate.directory} className="rounded-md bg-muted/40 p-2 text-xs">
                    <p className="font-mono font-medium">{candidate.directory} <span className="font-sans font-normal text-muted-foreground">· {candidate.buildMode} · port {candidate.port}</span></p>
                    <p className="mt-1 text-muted-foreground">{candidate.evidence[0]?.detail ?? "Review this directory before release."}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => applyCandidate(candidate, "first")}>Use for first service</Button>
                      <Button type="button" size="sm" variant="outline" disabled={services.length >= 32} onClick={() => applyCandidate(candidate, "http")}>Add HTTP</Button>
                      <Button type="button" size="sm" variant="outline" disabled={services.length >= 32} onClick={() => applyCandidate(candidate, "worker")}>Add worker</Button>
                    </div>
                  </div>
                ))}
              </div>
            </> : null}
          </div>
          <details className="rounded-md bg-muted/40 p-3">
            <summary className="cursor-pointer text-sm font-medium">Project options and shared variables</summary>
            <div className="mt-3">
              <label className="mb-3 flex items-center gap-2 text-sm">
                <Checkbox checked={autoDeploy} onChange={(event) => setAutoDeploy(event.target.checked)} />
                Release this project when its configured branch receives a push
              </label>
              <Field label="One KEY=value per line (optional)">
                <Textarea
                  value={projectVariables}
                  onChange={(event) => setProjectVariables(event.target.value)}
                  placeholder={"NODE_ENV=production\nREDIS_DB=2"}
                />
              </Field>
              <p className="mt-2 text-xs text-muted-foreground">
                These values are encrypted and inherited by every service. Service values override
                matching keys.
              </p>
            </div>
          </details>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Services</p>
              <p className="text-xs text-muted-foreground">
                HTTP services are routed publicly; workers and release jobs remain private.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={services.length >= 32} onClick={() => addService("http")}>
                <Plus className="mr-1 h-4 w-4" /> HTTP
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={services.length >= 32} onClick={() => addService("worker")}>
                <Plus className="mr-1 h-4 w-4" /> Worker
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={services.length >= 32 || services.some((service) => service.kind === "release")} onClick={() => addService("release")}>
                <Plus className="mr-1 h-4 w-4" /> Release job
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            {services.map((service, index) => {
              const hasAnotherRelease = services.some(
                (candidate) => candidate.kind === "release" && candidate.key !== service.key
              );
              return (
                <div key={service.key} className="rounded-lg border p-4">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">{service.name || `Service ${index + 1}`} <span className="font-normal text-muted-foreground">· {service.kind === "http" ? "Public HTTP" : service.kind === "worker" ? "Private worker" : "One-time release job"}</span></p>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={services.length === 1}
                      onClick={() =>
                        setServices((current) =>
                          current.filter((candidate) => candidate.key !== service.key)
                        )
                      }
                      aria-label={`Remove ${service.name || `service ${index + 1}`}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Name">
                      <Input
                        value={service.name}
                        onChange={(event) => updateService(service.key, { name: event.target.value })}
                        required
                      />
                    </Field>
                    <Field label="Slug">
                      <Input
                        value={service.slug}
                        onChange={(event) =>
                          updateService(service.key, { slug: event.target.value.toLowerCase() })
                        }
                        pattern="[a-z0-9-]+"
                        required
                      />
                    </Field>
                    <Field label="Type">
                      <Select
                        value={service.kind}
                        onValueChange={(value) => {
                          const kind = value as ServiceDraft["kind"];
                          updateService(service.key, {
                            kind,
                            port: kind === "http" ? service.port || "3000" : "",
                            domains: kind === "http" ? service.domains : "",
                            restartPolicy: kind === "release" ? "no" : "unless-stopped",
                            startedDependencies: kind === "release" ? "" : service.startedDependencies,
                            healthyDependencies: kind === "release" ? "" : service.healthyDependencies
                          });
                        }}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="http">HTTP</SelectItem>
                          <SelectItem value="worker">Worker</SelectItem>
                          <SelectItem value="release" disabled={hasAnotherRelease}>Release job</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Service directory">
                      <Input
                        value={service.serviceDirectory}
                        onChange={(event) =>
                          updateService(service.key, { serviceDirectory: event.target.value })
                        }
                        placeholder="apps/api"
                        required
                      />
                    </Field>
                    {service.kind === "http" ? <Field label="Container port">
                      <Input type="number" min={1} max={65535} value={service.port} onChange={(event) => updateService(service.key, { port: event.target.value })} required />
                    </Field> : null}
                  </div>

                  <details className="mt-4 rounded-md bg-muted/40 p-3">
                    <summary className="cursor-pointer text-sm font-medium">Build, variables, and advanced settings</summary>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field label="Build mode">
                        <Select value={service.buildMode} onValueChange={(value) => updateService(service.key, { buildMode: value as ServiceDraft["buildMode"] })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Auto-detect</SelectItem>
                            <SelectItem value="dockerfile">Dockerfile</SelectItem>
                            <SelectItem value="nixpacks">Nixpacks</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Workspace selector (optional)">
                        <Input value={service.workspaceSelector} onChange={(event) => updateService(service.key, { workspaceSelector: event.target.value })} placeholder="@acme/api" />
                      </Field>
                      <Field label="Dockerfile path">
                        <Input value={service.dockerfilePath} onChange={(event) => updateService(service.key, { dockerfilePath: event.target.value })} placeholder="apps/api/Dockerfile" required />
                      </Field>
                      <Field label="Docker target (optional)">
                        <Input value={service.dockerTarget} onChange={(event) => updateService(service.key, { dockerTarget: event.target.value })} placeholder="runtime" />
                      </Field>
                      <Field label="Shared image group (optional)">
                        <Input value={service.imageGroup} onChange={(event) => updateService(service.key, { imageGroup: event.target.value })} placeholder="backend" />
                      </Field>
                      {service.kind === "http" ? <Field label="Custom domains (comma-separated)">
                        <Input value={service.domains} onChange={(event) => updateService(service.key, { domains: event.target.value })} placeholder="api.example.com, alternate.example.com" />
                      </Field> : null}
                      <Field label="Build command (optional)">
                        <Input
                          value={service.buildCmd}
                          onChange={(event) =>
                            updateService(service.key, { buildCmd: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="Image start command (optional)">
                        <Input
                          value={service.startCmd}
                          onChange={(event) =>
                            updateService(service.key, { startCmd: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="Runtime command override (optional)" className="sm:col-span-2">
                        <Input
                          value={service.runtimeCmd}
                          onChange={(event) =>
                            updateService(service.key, { runtimeCmd: event.target.value })
                          }
                          placeholder="node dist/worker.js"
                        />
                      </Field>
                      <Field label="Memory limit, MB (optional)">
                        <Input
                          type="number"
                          min={16}
                          max={65536}
                          value={service.memoryLimitMb}
                          onChange={(event) =>
                            updateService(service.key, { memoryLimitMb: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="CPU limit (optional)">
                        <Input
                          type="number"
                          min={0.1}
                          max={64}
                          step={0.1}
                          value={service.cpuLimit}
                          onChange={(event) =>
                            updateService(service.key, { cpuLimit: event.target.value })
                          }
                        />
                      </Field>
                      {service.kind !== "release" ? (
                        <Field label="Restart policy">
                          <Select
                            value={service.restartPolicy}
                            onValueChange={(value) =>
                              updateService(service.key, {
                                restartPolicy: value as ServiceDraft["restartPolicy"]
                              })
                            }
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="unless-stopped">Unless stopped</SelectItem>
                              <SelectItem value="on-failure">On failure</SelectItem>
                              <SelectItem value="always">Always</SelectItem>
                              <SelectItem value="no">Never</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                      ) : null}
                      {service.kind !== "release" ? (
                        <>
                          <Field label="Wait until started (service slugs)">
                            <Input
                              value={service.startedDependencies}
                              onChange={(event) =>
                                updateService(service.key, {
                                  startedDependencies: event.target.value
                                })
                              }
                              placeholder="api, cache-proxy"
                            />
                          </Field>
                          <Field label="Wait until healthy (service slugs)">
                            <Input
                              value={service.healthyDependencies}
                              onChange={(event) =>
                                updateService(service.key, {
                                  healthyDependencies: event.target.value
                                })
                              }
                              placeholder="api"
                            />
                          </Field>
                        </>
                      ) : null}
                      <Field label="Health check command (optional)" className="sm:col-span-2">
                        <Textarea
                          value={service.healthCheckCmd}
                          onChange={(event) =>
                            updateService(service.key, { healthCheckCmd: event.target.value })
                          }
                          placeholder="curl --fail http://localhost:3000/health"
                        />
                      </Field>
                      <ServiceVariableDraftEditor
                        entries={service.variables}
                        onChange={(variables) => updateService(service.key, { variables })}
                      />
                    </div>
                    {service.healthCheckCmd.trim() ? (
                      <div className="mt-3 grid gap-3 sm:grid-cols-4">
                        <Field label="Interval (seconds)">
                          <Input
                            type="number"
                            min={1}
                            max={300}
                            value={service.healthCheckIntervalSeconds}
                            onChange={(event) =>
                              updateService(service.key, {
                                healthCheckIntervalSeconds: event.target.value
                              })
                            }
                            required
                          />
                        </Field>
                        <Field label="Timeout (seconds)">
                          <Input
                            type="number"
                            min={1}
                            max={60}
                            value={service.healthCheckTimeoutSeconds}
                            onChange={(event) =>
                              updateService(service.key, {
                                healthCheckTimeoutSeconds: event.target.value
                              })
                            }
                            required
                          />
                        </Field>
                        <Field label="Retries">
                          <Input
                            type="number"
                            min={1}
                            max={30}
                            value={service.healthCheckRetries}
                            onChange={(event) =>
                              updateService(service.key, {
                                healthCheckRetries: event.target.value
                              })
                            }
                            required
                          />
                        </Field>
                        <Field label="Start period (seconds)">
                          <Input
                            type="number"
                            min={0}
                            max={600}
                            value={service.healthCheckStartPeriodSeconds}
                            onChange={(event) =>
                              updateService(service.key, {
                                healthCheckStartPeriodSeconds: event.target.value
                              })
                            }
                            required
                          />
                        </Field>
                      </div>
                    ) : null}
                  </details>
                </div>
              );
            })}
          </div>
            </>
          ) : (
            <div className="space-y-3">
              <Field label="Project configuration JSON">
                <Textarea
                  className="min-h-[420px] font-mono text-xs"
                  value={jsonConfig}
                  onChange={(event) => setJsonConfig(event.target.value)}
                  spellCheck={false}
                  aria-label="Project configuration JSON"
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => jsonFileInput.current?.click()}
                >
                  <Upload className="mr-1 h-4 w-4" /> Upload JSON file
                </Button>
                <input
                  ref={jsonFileInput}
                  className="hidden"
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    void file
                      .text()
                      .then((text) => {
                        const parsed = JSON.parse(text) as unknown;
                        const validated = CreateProjectSchema.parse(parsed);
                        setJsonConfig(JSON.stringify(validated, null, 2));
                        toast.success(`Loaded ${file.name}`);
                      })
                      .catch((error: unknown) => toast.error(projectConfigError(error)));
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Paste or upload the full project object. It uses the same validation as the form,
                  including pnpm workspace selectors, commands, dependencies, variables, and build
                  arguments.
                </p>
              </div>
            </div>
          )}
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" value="release" disabled={pending}>
              <Rocket className="mr-2 h-4 w-4" />{create.isPending ? "Creating…" : "Create and release"}
            </Button>
            <Button type="submit" value="save" variant="outline" disabled={pending}>Save draft</Button>
          </div>
        </form>
        </>}
      </DialogContent>
    </Dialog>
  );
}

function ProjectLogs({ project }: { project: ProjectRow }) {
  const [lines, setLines] = useState<string[]>([]);
  const [serviceId, setServiceId] = useState("all");
  const projectId = project.id;
  const serviceLabelKey = JSON.stringify(
    project.services.map((service) => [service.id, service.slug])
  );
  useEffect(() => {
    const serviceLabels = new Map<string, string>(JSON.parse(serviceLabelKey));
    const query = new URLSearchParams({ limit: "200" });
    if (serviceId !== "all") query.set("serviceId", serviceId);
    const source = new EventSource(`/api/projects/${projectId}/logs?${query.toString()}`);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as {
        type: string;
        logs?: { stream: string; message: string; serviceId: string }[];
        stream?: string;
        message?: string;
        serviceId?: string;
      };
      const serviceName = (id: string | undefined) =>
        (id ? serviceLabels.get(id) : undefined) ?? id?.slice(0, 8) ?? "service";
      const next =
        payload.type === "replay"
          ? (payload.logs ?? []).map(
              (line) => `[${serviceName(line.serviceId)} ${line.stream}] ${line.message}`
            )
          : payload.message
            ? [`[${serviceName(payload.serviceId)} ${payload.stream ?? "stdout"}] ${payload.message}`]
            : [];
      setLines((current) => [...(payload.type === "replay" ? [] : current), ...next].slice(-500));
    };
    return () => source.close();
  }, [projectId, serviceId, serviceLabelKey]);
  return (
    <div className="mt-3 space-y-2">
      <Select
        value={serviceId}
        onValueChange={(value) => {
          setLines([]);
          setServiceId(value);
        }}
      >
        <SelectTrigger className="w-full sm:w-56"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All services</SelectItem>
          {project.services.map((service) => (
            <SelectItem key={service.id} value={service.id}>
              {service.name} ({service.kind})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
        {lines.length ? lines.join("\n") : "No service logs yet."}
      </pre>
    </div>
  );
}

function ProjectCard({ project, canEdit, justReleased }: { project: ProjectRow; canEdit: boolean; justReleased: boolean }) {
  const client = useQueryClient();
  const [logs, setLogs] = useState(false);
  const [editing, setEditing] = useState(false);
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
  const latest = project.releases[0];
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
    <Card className={justReleased ? "border-primary/60" : undefined}>
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
        {latest ? (
          <div className="mt-4 rounded-md border border-border/70 bg-muted/20 p-3 text-sm" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Latest release</span>
              <Badge variant="outline">{latest.status}</Badge>
              {latest.commitSha ? <span className="font-mono text-xs text-muted-foreground">{latest.commitSha.slice(0, 12)}</span> : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {latest.serviceDeployments.map((deployment) => (
                <span key={deployment.id} className="rounded bg-background px-2 py-1 text-xs">
                  {deployment.service.slug}: {deployment.status}
                </span>
              ))}
            </div>
            {latest.errorMessage ? <p className="mt-2 text-destructive">{latest.errorMessage}</p> : null}
            {latest.serviceDeployments.filter((deployment) => deployment.errorMessage).map((deployment) => (
              <p key={deployment.id} className="mt-1 text-xs text-destructive">{deployment.service.name}: {deployment.errorMessage}</p>
            ))}
          </div>
        ) : <p className="mt-4 text-xs text-muted-foreground">Draft · ready for its first release</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => deploy.mutate()} disabled={deploy.isPending || latest?.status === "pending" || latest?.status === "building" || latest?.status === "releasing" || latest?.status === "deploying"}>
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
          {canEdit ? (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Settings className="mr-2 h-4 w-4" /> Configure
            </Button>
          ) : null}
        </div>
        {logs ? <ProjectLogs project={project} /> : null}
        {editing ? (
          <EditProjectDialog project={project} open={editing} onOpenChange={setEditing} />
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ProjectsPage() {
  const [open, setOpen] = useState(false);
  const [justReleasedId, setJustReleasedId] = useState<string | null>(null);
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
      <CreateProjectDialog open={open} onOpenChange={setOpen} onReleased={setJustReleasedId} />
      {projects.isError ? <p className="text-destructive">Could not load projects.</p> : null}
      {projects.data?.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No projects yet"
          description="Group HTTP services, private workers, and release commands into one coordinated deployment."
          action={isAdmin(me) ? <Button onClick={() => setOpen(true)}>Create project</Button> : undefined}
        />
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {projects.data?.map((project) => (
          <ProjectCard key={project.id} project={project} canEdit={isAdmin(me)} justReleased={justReleasedId === project.id} />
        ))}
      </div>
    </div>
  );
}
