import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BuildArgsPatchSchema,
  CreateProjectSchema,
  EnvVarsPatchSchema,
  ServiceDomainsReplaceSchema,
  UpdateProjectSchema,
  UpdateServiceSchema,
  normalizeHostname
} from "@sohwe/types";
import { FileJson, Upload } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, apiGet } from "@/lib/api";
import type { Datastore, ProjectRow, ProjectService } from "@/lib/types";

type ServiceDraft = {
  id: string;
  name: string;
  slug: string;
  kind: ProjectService["kind"];
  buildMode: ProjectService["buildMode"];
  buildCmd: string;
  startCmd: string;
  runtimeCmd: string;
  serviceDirectory: string;
  workspaceSelector: string;
  dockerfilePath: string;
  dockerTarget: string;
  imageGroup: string;
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
  variableChanges: string;
  buildArgChanges: string;
};

type MaskedVariablePreview = { key: string; preview: string };

type ProjectVariablePreviews = {
  project: MaskedVariablePreview[];
  services: {
    id: string;
    envVars: MaskedVariablePreview[];
    buildArgs: MaskedVariablePreview[];
  }[];
};

const STORED_VALUE_PREFIX = "<stored:";

function previewMap(items: MaskedVariablePreview[] | undefined): Record<string, string> {
  return Object.fromEntries(
    (items ?? []).map(({ key, preview }) => [key, `${STORED_VALUE_PREFIX}${preview}>`])
  );
}

function changedValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => !(value.startsWith(STORED_VALUE_PREFIX) && value.endsWith(">"))
    )
  );
}

function jsonConfigFrom(
  project: ProjectRow,
  previews?: ProjectVariablePreviews
): string {
  const previewsByService = new Map(
    (previews?.services ?? []).map((service) => [service.id, service])
  );
  return JSON.stringify(
    {
      name: project.name,
      slug: project.slug,
      gitRepo: project.gitRepo,
      gitBranch: project.gitBranch,
      autoDeploy: project.autoDeploy,
      envVars: previewMap(previews?.project),
      services: project.services.map((service) => {
        const stored = previewsByService.get(service.id);
        return {
          name: service.name,
          slug: service.slug,
          kind: service.kind,
          buildMode: service.buildMode,
          buildCmd: service.buildCmd ?? undefined,
          startCmd: service.startCmd ?? undefined,
          runtimeCmd: service.runtimeCmd ?? undefined,
          serviceDirectory: service.serviceDirectory,
          workspaceSelector: service.workspaceSelector ?? undefined,
          dockerfilePath: service.dockerfilePath,
          dockerTarget: service.dockerTarget ?? undefined,
          imageGroup: service.imageGroup ?? undefined,
          port: service.port ?? undefined,
          domains: service.domains.map((domain) => domain.hostname),
          memoryLimitMb: service.memoryLimitMb ?? undefined,
          cpuLimit: service.cpuLimit ?? undefined,
          restartPolicy: service.kind === "release" ? "no" : service.restartPolicy,
          dependsOn: service.dependencies.map((dependency) => ({
            serviceSlug: dependency.dependencyService.slug,
            condition: dependency.condition
          })),
          healthCheckCmd: service.healthCheckCmd ?? undefined,
          healthCheckIntervalSeconds: service.healthCheckIntervalSeconds,
          healthCheckTimeoutSeconds: service.healthCheckTimeoutSeconds,
          healthCheckRetries: service.healthCheckRetries,
          healthCheckStartPeriodSeconds: service.healthCheckStartPeriodSeconds,
          envVars: previewMap(stored?.envVars),
          buildArgs: previewMap(stored?.buildArgs)
        };
      })
    },
    null,
    2
  );
}

function jsonConfigError(error: unknown): string {
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

function draftFrom(service: ProjectService): ServiceDraft {
  const dependencies = (condition: "started" | "healthy") =>
    service.dependencies
      .filter((dependency) => dependency.condition === condition)
      .map((dependency) => dependency.dependencyService.slug)
      .join(", ");
  return {
    id: service.id,
    name: service.name,
    slug: service.slug,
    kind: service.kind,
    buildMode: service.buildMode,
    buildCmd: service.buildCmd ?? "",
    startCmd: service.startCmd ?? "",
    runtimeCmd: service.runtimeCmd ?? "",
    serviceDirectory: service.serviceDirectory,
    workspaceSelector: service.workspaceSelector ?? "",
    dockerfilePath: service.dockerfilePath,
    dockerTarget: service.dockerTarget ?? "",
    imageGroup: service.imageGroup ?? "",
    port: service.port == null ? "" : String(service.port),
    domains: service.domains.map((domain) => domain.hostname).join(", "),
    memoryLimitMb: service.memoryLimitMb == null ? "" : String(service.memoryLimitMb),
    cpuLimit: service.cpuLimit == null ? "" : String(service.cpuLimit),
    restartPolicy: service.restartPolicy as ServiceDraft["restartPolicy"],
    startedDependencies: dependencies("started"),
    healthyDependencies: dependencies("healthy"),
    healthCheckCmd: service.healthCheckCmd ?? "",
    healthCheckIntervalSeconds: String(service.healthCheckIntervalSeconds),
    healthCheckTimeoutSeconds: String(service.healthCheckTimeoutSeconds),
    healthCheckRetries: String(service.healthCheckRetries),
    healthCheckStartPeriodSeconds: String(service.healthCheckStartPeriodSeconds),
    variableChanges: "",
    buildArgChanges: ""
  };
}

function nullableText(value: string): string | null {
  return value.trim() || null;
}

function nullableNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}

function commaSeparated(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function variablePatchLines(value: string): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = Object.create(null);
  const unset: string[] = [];
  value.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("-") && !line.includes("=")) {
      const key = line.slice(1).trim();
      if (!key) throw new Error(`Variable line ${index + 1} needs a key after -`);
      unset.push(key);
      return;
    }
    const separator = rawLine.indexOf("=");
    if (separator < 1) {
      throw new Error(`Variable line ${index + 1} must use KEY=value or -KEY`);
    }
    set[rawLine.slice(0, separator).trim()] = rawLine.slice(separator + 1);
  });
  return { set, unset };
}

function hasPatch(patch: {
  set?: Record<string, string>;
  unset?: string[];
}): boolean {
  return Object.keys(patch.set ?? {}).length > 0 || (patch.unset?.length ?? 0) > 0;
}

export function EditProjectDialog({
  project,
  open,
  onOpenChange
}: {
  project: ProjectRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(project.name);
  const [repo, setRepo] = useState(project.gitRepo);
  const [branch, setBranch] = useState(project.gitBranch);
  const [autoDeploy, setAutoDeploy] = useState(project.autoDeploy);
  const [projectVariableChanges, setProjectVariableChanges] = useState("");
  const [services, setServices] = useState<ServiceDraft[]>(() =>
    project.services.map(draftFrom)
  );
  const [inputMode, setInputMode] = useState<"form" | "json">("form");
  const [jsonConfig, setJsonConfig] = useState(() => jsonConfigFrom(project));
  const [jsonPreviewsLoaded, setJsonPreviewsLoaded] = useState(false);
  const [jsonPreviewsLoading, setJsonPreviewsLoading] = useState(false);
  const jsonFileInput = useRef<HTMLInputElement>(null);

  function updateService(id: string, patch: Partial<ServiceDraft>) {
    setServices((current) =>
      current.map((service) => (service.id === id ? { ...service, ...patch } : service))
    );
  }

  async function importJsonFile(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      const config = CreateProjectSchema.parse(JSON.parse(await file.text()) as unknown);
      if (config.slug !== project.slug) {
        throw new Error(`Project slug must remain "${project.slug}"`);
      }
      setJsonConfig(JSON.stringify(config, null, 2));
      toast.success("Project JSON loaded");
    } catch (error) {
      toast.error(jsonConfigError(error));
    }
  }

  async function openJsonEditor(): Promise<void> {
    setInputMode("json");
    if (jsonPreviewsLoaded || jsonPreviewsLoading) return;
    setJsonPreviewsLoading(true);
    try {
      const previews = await apiGet<ProjectVariablePreviews>(
        `/api/projects/${project.id}/variable-previews`
      );
      setJsonConfig(jsonConfigFrom(project, previews));
      setJsonPreviewsLoaded(true);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not load stored variable previews"
      );
    } finally {
      setJsonPreviewsLoading(false);
    }
  }

  async function saveJsonConfiguration(): Promise<void> {
    const config = CreateProjectSchema.parse(JSON.parse(jsonConfig) as unknown);
    if (config.slug !== project.slug) {
      throw new Error(
        `Project slug must remain "${project.slug}" because it identifies the project network`
      );
    }

    const currentBySlug = new Map(project.services.map((service) => [service.slug, service]));
    for (const service of config.services) {
      const current = currentBySlug.get(service.slug);
      if (current && current.kind !== service.kind) {
        throw new Error(
          `Service ${service.slug} must remain type ${current.kind}; service types cannot be changed in place`
        );
      }
    }

    await api(`/api/projects/${project.id}`, {
      method: "PATCH",
      body: JSON.stringify(
        UpdateProjectSchema.parse({
          name: config.name,
          gitRepo: config.gitRepo,
          gitBranch: config.gitBranch,
          autoDeploy: config.autoDeploy
        })
      )
    });
    const projectEnvChanges = changedValues(config.envVars);
    if (Object.keys(projectEnvChanges).length > 0) {
      await api(`/api/projects/${project.id}/variables`, {
        method: "PATCH",
        body: JSON.stringify(
          EnvVarsPatchSchema.parse({ set: projectEnvChanges, unset: [] })
        )
      });
    }

    // Add missing services without dependencies first. Once every slug exists,
    // dependency patches can safely reference services introduced by this same
    // JSON document.
    const serviceIds = new Map(
      project.services.map((service) => [service.slug, service.id])
    );
    for (const service of config.services) {
      if (serviceIds.has(service.slug)) continue;
      const envVars = changedValues(service.envVars);
      const buildArgs = changedValues(service.buildArgs);
      const created = await api<ProjectService>(`/api/projects/${project.id}/services`, {
        method: "POST",
        body: JSON.stringify({ ...service, envVars, buildArgs, dependsOn: [] })
      });
      serviceIds.set(service.slug, created.id);
    }

    await Promise.all(
      config.services.map(async (service) => {
        const serviceId = serviceIds.get(service.slug);
        if (!serviceId) throw new Error(`Could not resolve service ${service.slug}`);
        const servicePatch = UpdateServiceSchema.parse({
          name: service.name,
          buildMode: service.buildMode,
          buildCmd: service.buildCmd ?? null,
          startCmd: service.startCmd ?? null,
          runtimeCmd: service.runtimeCmd ?? null,
          serviceDirectory: service.serviceDirectory,
          workspaceSelector: service.workspaceSelector ?? null,
          dockerfilePath: service.dockerfilePath,
          dockerTarget: service.dockerTarget ?? null,
          imageGroup: service.imageGroup ?? null,
          port: service.kind === "http" ? service.port : null,
          memoryLimitMb: service.memoryLimitMb ?? null,
          cpuLimit: service.cpuLimit ?? null,
          restartPolicy: service.kind === "release" ? "no" : service.restartPolicy,
          dependsOn: service.kind === "release" ? [] : service.dependsOn,
          healthCheckCmd: service.healthCheckCmd ?? null,
          healthCheckIntervalSeconds: service.healthCheckIntervalSeconds,
          healthCheckTimeoutSeconds: service.healthCheckTimeoutSeconds,
          healthCheckRetries: service.healthCheckRetries,
          healthCheckStartPeriodSeconds: service.healthCheckStartPeriodSeconds
        });
        await api(`/api/services/${serviceId}`, {
          method: "PATCH",
          body: JSON.stringify(servicePatch)
        });
        await api(`/api/services/${serviceId}/domains`, {
          method: "PUT",
          body: JSON.stringify(
            ServiceDomainsReplaceSchema.parse({ domains: service.domains })
          )
        });
        const envVars = changedValues(service.envVars);
        if (Object.keys(envVars).length > 0) {
          await api(`/api/services/${serviceId}/variables`, {
            method: "PATCH",
            body: JSON.stringify(
              EnvVarsPatchSchema.parse({ set: envVars, unset: [] })
            )
          });
        }
        const buildArgs = changedValues(service.buildArgs);
        if (Object.keys(buildArgs).length > 0) {
          await api(`/api/services/${serviceId}/build-args`, {
            method: "PATCH",
            body: JSON.stringify(
              BuildArgsPatchSchema.parse({ set: buildArgs, unset: [] })
            )
          });
        }
      })
    );
  }

  const save = useMutation({
    mutationFn: async () => {
      if (inputMode === "json") {
        await saveJsonConfiguration();
        return;
      }
      const projectPatch = UpdateProjectSchema.parse({
        name,
        gitRepo: repo,
        gitBranch: branch,
        autoDeploy
      });
      const projectVariables = EnvVarsPatchSchema.parse(
        variablePatchLines(projectVariableChanges)
      );

      await api(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify(projectPatch)
      });
      if (hasPatch(projectVariables)) {
        await api(`/api/projects/${project.id}/variables`, {
          method: "PATCH",
          body: JSON.stringify(projectVariables)
        });
      }

      await Promise.all(
        services.map(async (service) => {
          const healthy = commaSeparated(service.healthyDependencies);
          const started = commaSeparated(service.startedDependencies).filter(
            (slug) => !healthy.includes(slug)
          );
          const servicePatch = UpdateServiceSchema.parse({
            name: service.name,
            buildMode: service.buildMode,
            buildCmd: nullableText(service.buildCmd),
            startCmd: nullableText(service.startCmd),
            runtimeCmd: nullableText(service.runtimeCmd),
            serviceDirectory: service.serviceDirectory,
            workspaceSelector: nullableText(service.workspaceSelector),
            dockerfilePath: service.dockerfilePath,
            dockerTarget: nullableText(service.dockerTarget),
            imageGroup: nullableText(service.imageGroup),
            port: service.kind === "http" ? nullableNumber(service.port) : null,
            memoryLimitMb: nullableNumber(service.memoryLimitMb),
            cpuLimit: nullableNumber(service.cpuLimit),
            restartPolicy: service.kind === "release" ? "no" : service.restartPolicy,
            dependsOn:
              service.kind === "release"
                ? []
                : [
                    ...started.map((serviceSlug) => ({ serviceSlug, condition: "started" as const })),
                    ...healthy.map((serviceSlug) => ({ serviceSlug, condition: "healthy" as const }))
                  ],
            healthCheckCmd: nullableText(service.healthCheckCmd),
            healthCheckIntervalSeconds: Number(service.healthCheckIntervalSeconds),
            healthCheckTimeoutSeconds: Number(service.healthCheckTimeoutSeconds),
            healthCheckRetries: Number(service.healthCheckRetries),
            healthCheckStartPeriodSeconds: Number(service.healthCheckStartPeriodSeconds)
          });
          const domains = ServiceDomainsReplaceSchema.parse({
            domains:
              service.kind === "http"
                ? commaSeparated(service.domains).map(normalizeHostname)
                : []
          });
          const variables = EnvVarsPatchSchema.parse(
            variablePatchLines(service.variableChanges)
          );
          const buildArgs = BuildArgsPatchSchema.parse(
            variablePatchLines(service.buildArgChanges)
          );

          await api(`/api/services/${service.id}`, {
            method: "PATCH",
            body: JSON.stringify(servicePatch)
          });
          await api(`/api/services/${service.id}/domains`, {
            method: "PUT",
            body: JSON.stringify(domains)
          });
          if (hasPatch(variables)) {
            await api(`/api/services/${service.id}/variables`, {
              method: "PATCH",
              body: JSON.stringify(variables)
            });
          }
          if (hasPatch(buildArgs)) {
            await api(`/api/services/${service.id}/build-args`, {
              method: "PATCH",
              body: JSON.stringify(buildArgs)
            });
          }
        })
      );
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
      toast.success("Project configuration saved");
    },
    onError: (error) => toast.error(jsonConfigError(error))
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Edit {project.name}</DialogTitle>
          <DialogDescription>
            Changes apply to the next coordinated release. The project and service slugs stay fixed
            because they identify the private network and its services.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1">
          <Button
            type="button"
            size="sm"
            variant={inputMode === "form" ? "default" : "ghost"}
            onClick={() => setInputMode("form")}
          >
            Form
          </Button>
          <Button
            type="button"
            size="sm"
            variant={inputMode === "json" ? "default" : "ghost"}
            disabled={jsonPreviewsLoading}
            onClick={() => void openJsonEditor()}
          >
            <FileJson className="mr-2 size-4" />
            {jsonPreviewsLoading ? "Loading JSON…" : "JSON"}
          </Button>
        </div>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          {inputMode === "form" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project name">
              <Input value={name} onChange={(event) => setName(event.target.value)} required />
            </Field>
            <Field label="Project slug">
              <Input value={project.slug} disabled />
            </Field>
          </div>
          <Field label="Git repository URL">
            <Input value={repo} onChange={(event) => setRepo(event.target.value)} type="url" required />
          </Field>
          <Field label="Branch">
            <Input value={branch} onChange={(event) => setBranch(event.target.value)} required />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoDeploy}
              onChange={(event) => setAutoDeploy(event.target.checked)}
            />
            Deploy this project when its configured branch receives a push
          </label>
          <Field label="Shared variable changes (optional)">
            <Textarea
              value={projectVariableChanges}
              onChange={(event) => setProjectVariableChanges(event.target.value)}
              placeholder={"KEY=new value\n-KEY_TO_REMOVE"}
            />
            <span className="text-xs font-normal text-muted-foreground">
              Stored values remain hidden and unchanged. Use KEY=value to add or update one, and
              -KEY to remove one.
            </span>
          </Field>

          <div className="space-y-4">
            {services.map((service) => (
              <details key={service.id} className="rounded-lg border p-4" open>
                <summary className="cursor-pointer text-sm font-medium">
                  {service.name} ({service.kind})
                </summary>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <Field label="Name">
                    <Input
                      value={service.name}
                      onChange={(event) => updateService(service.id, { name: event.target.value })}
                      required
                    />
                  </Field>
                  <Field label="Slug">
                    <Input value={service.slug} disabled />
                  </Field>
                  <Field label="Type">
                    <Input value={service.kind} disabled />
                  </Field>
                  <Field label="Build mode">
                    <Select
                      value={service.buildMode}
                      onValueChange={(value) =>
                        updateService(service.id, {
                          buildMode: value as ServiceDraft["buildMode"]
                        })
                      }
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dockerfile">Dockerfile</SelectItem>
                        <SelectItem value="auto">Auto-detect</SelectItem>
                        <SelectItem value="nixpacks">Nixpacks</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Service directory">
                    <Input
                      value={service.serviceDirectory}
                      onChange={(event) =>
                        updateService(service.id, { serviceDirectory: event.target.value })
                      }
                      required
                    />
                  </Field>
                  <Field label="Workspace selector (optional)">
                    <Input
                      value={service.workspaceSelector}
                      onChange={(event) =>
                        updateService(service.id, { workspaceSelector: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Dockerfile path">
                    <Input
                      value={service.dockerfilePath}
                      onChange={(event) =>
                        updateService(service.id, { dockerfilePath: event.target.value })
                      }
                      required
                    />
                  </Field>
                  <Field label="Docker target (optional)">
                    <Input
                      value={service.dockerTarget}
                      onChange={(event) =>
                        updateService(service.id, { dockerTarget: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Shared image group (optional)">
                    <Input
                      value={service.imageGroup}
                      onChange={(event) =>
                        updateService(service.id, { imageGroup: event.target.value })
                      }
                    />
                  </Field>
                  {service.kind === "http" ? (
                    <>
                      <Field label="Container port">
                        <Input
                          type="number"
                          min={1}
                          max={65535}
                          value={service.port}
                          onChange={(event) => updateService(service.id, { port: event.target.value })}
                          required
                        />
                      </Field>
                      <Field label="Custom domains" className="sm:col-span-2">
                        <Input
                          value={service.domains}
                          onChange={(event) =>
                            updateService(service.id, { domains: event.target.value })
                          }
                          placeholder="app.example.com, alternate.example.com"
                        />
                      </Field>
                    </>
                  ) : null}
                  <Field label="Build command (optional)">
                    <Input
                      value={service.buildCmd}
                      onChange={(event) => updateService(service.id, { buildCmd: event.target.value })}
                    />
                  </Field>
                  <Field label="Image start command (optional)">
                    <Input
                      value={service.startCmd}
                      onChange={(event) => updateService(service.id, { startCmd: event.target.value })}
                    />
                  </Field>
                  <Field label="Runtime command override (optional)">
                    <Input
                      value={service.runtimeCmd}
                      onChange={(event) =>
                        updateService(service.id, { runtimeCmd: event.target.value })
                      }
                      placeholder="Leave empty to use the image command"
                    />
                  </Field>
                  <Field label="Memory limit, MB (optional)">
                    <Input
                      type="number"
                      min={16}
                      max={65536}
                      value={service.memoryLimitMb}
                      onChange={(event) =>
                        updateService(service.id, { memoryLimitMb: event.target.value })
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
                        updateService(service.id, { cpuLimit: event.target.value })
                      }
                    />
                  </Field>
                  {service.kind !== "release" ? (
                    <Field label="Restart policy">
                      <Select
                        value={service.restartPolicy}
                        onValueChange={(value) =>
                          updateService(service.id, {
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
                            updateService(service.id, { startedDependencies: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="Wait until healthy (service slugs)">
                        <Input
                          value={service.healthyDependencies}
                          onChange={(event) =>
                            updateService(service.id, { healthyDependencies: event.target.value })
                          }
                        />
                      </Field>
                    </>
                  ) : null}
                  <Field label="Health check command (optional)" className="sm:col-span-3">
                    <Textarea
                      value={service.healthCheckCmd}
                      onChange={(event) =>
                        updateService(service.id, { healthCheckCmd: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Interval (seconds)">
                    <Input
                      type="number"
                      min={1}
                      max={300}
                      value={service.healthCheckIntervalSeconds}
                      onChange={(event) =>
                        updateService(service.id, { healthCheckIntervalSeconds: event.target.value })
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
                        updateService(service.id, { healthCheckTimeoutSeconds: event.target.value })
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
                        updateService(service.id, { healthCheckRetries: event.target.value })
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
                        updateService(service.id, {
                          healthCheckStartPeriodSeconds: event.target.value
                        })
                      }
                      required
                    />
                  </Field>
                  <Field label="Runtime variable changes" className="sm:col-span-3">
                    <Textarea
                      value={service.variableChanges}
                      onChange={(event) =>
                        updateService(service.id, { variableChanges: event.target.value })
                      }
                      placeholder={"SUPPORT_EMAIL=support@example.com\n-OLD_KEY"}
                    />
                    <span className="text-xs font-normal text-muted-foreground">
                      Existing secret values stay hidden. Only the keys listed here will change.
                    </span>
                  </Field>
                  <Field label="Build argument changes" className="sm:col-span-3">
                    <Textarea
                      value={service.buildArgChanges}
                      onChange={(event) =>
                        updateService(service.id, { buildArgChanges: event.target.value })
                      }
                      placeholder={"PUBLIC_URL=https://example.com\n-OLD_BUILD_ARG"}
                    />
                  </Field>
                </div>
              </details>
            ))}
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <Field label="Project configuration JSON">
                <Textarea
                  className="min-h-[28rem] font-mono text-xs"
                  value={jsonConfig}
                  onChange={(event) => setJsonConfig(event.target.value)}
                  spellCheck={false}
                />
                <span className="text-xs font-normal text-muted-foreground">
                  Stored variables appear as masked values such as
                  {" "}<span className="font-mono">&lt;stored:supp•••.com&gt;</span>. Leave a
                  placeholder unchanged to preserve its encrypted value, or replace it to update
                  that key. Use Form mode to remove stored keys.
                </span>
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => jsonFileInput.current?.click()}
                >
                  <Upload className="mr-2 size-4" />
                  Upload JSON file
                </Button>
                <input
                  ref={jsonFileInput}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(event) => {
                    void importJsonFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Existing services are matched by slug; new slugs create services.
                </p>
              </div>
              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                Project and existing service slugs cannot change, and an existing service keeps its
                type. Services omitted from the JSON are left unchanged. Hidden environment values
                and build arguments are preserved when their JSON objects are empty; values you add
                are set or updated.
              </div>
            </div>
          )}
          {inputMode === "form" ? <ProjectDatastoreBindings project={project} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save configuration"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectDatastoreBindings({ project }: { project: ProjectRow }) {
  const client = useQueryClient();
  const projectQuery = useQuery({
    queryKey: ["project-configuration", project.id],
    queryFn: () => apiGet<ProjectRow>(`/api/projects/${project.id}`),
    initialData: project
  });
  const datastoresQuery = useQuery({
    queryKey: ["datastores"],
    queryFn: () => apiGet<{ datastores: Datastore[] }>("/api/datastores")
  });
  const [datastoreId, setDatastoreId] = useState("");
  const [envKey, setEnvKey] = useState("DATABASE_URL");
  const [serviceIds, setServiceIds] = useState<string[]>(() =>
    project.services.map((service) => service.id)
  );
  const [unbindId, setUnbindId] = useState<string | null>(null);

  const currentProject = projectQuery.data;
  const bindings = currentProject.datastoreBindings ?? [];
  const boundIds = new Set(bindings.map((binding) => binding.datastoreId));
  const availableDatastores = (datastoresQuery.data?.datastores ?? []).filter(
    (datastore) => !boundIds.has(datastore.id)
  );
  const selectedDatastore = availableDatastores.find(
    (datastore) => datastore.id === datastoreId
  );
  const unbindTarget = bindings.find((binding) => binding.id === unbindId);
  const serviceName = new Map(project.services.map((service) => [service.id, service.slug]));

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["project-configuration", project.id] });
    void client.invalidateQueries({ queryKey: ["projects"] });
    void client.invalidateQueries({ queryKey: ["datastores"] });
  };
  const bind = useMutation({
    mutationFn: () =>
      api(`/api/datastores/${datastoreId}/project-bindings`, {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          envKey: envKey.trim(),
          serviceIds
        })
      }),
    onSuccess: () => {
      refresh();
      setDatastoreId("");
      setServiceIds(project.services.map((service) => service.id));
      toast.success("Datastore bound — it will be injected on the next release");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not bind datastore")
  });
  const unbind = useMutation({
    mutationFn: (binding: (typeof bindings)[number]) =>
      api(`/api/datastores/${binding.datastoreId}/project-bindings/${binding.id}`, {
        method: "DELETE"
      }),
    onSuccess: () => {
      refresh();
      toast.success("Datastore binding removed for the next release");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not remove binding")
  });

  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm font-medium">Datastore bindings</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Selected services receive a private connection URL on the project&apos;s next coordinated
        release. Release jobs can be selected for migrations too.
      </p>
      <div className="mt-3 space-y-2">
        {bindings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No datastores bound.</p>
        ) : null}
        {bindings.map((binding) => {
          const selected =
            binding.serviceIds.length === 0
              ? "all services"
              : binding.serviceIds.map((id) => serviceName.get(id) ?? id.slice(0, 8)).join(", ");
          return (
            <div
              key={binding.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium">
                  {binding.datastore.name} ({binding.datastore.kind})
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {binding.envKey} → {selected}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={unbind.isPending}
                onClick={() => setUnbindId(binding.id)}
              >
                Unbind
              </Button>
            </div>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Datastore">
          <Select
            value={datastoreId}
            onValueChange={(id) => {
              setDatastoreId(id);
              const datastore = availableDatastores.find((candidate) => candidate.id === id);
              setEnvKey(datastore?.kind === "redis" ? "REDIS_URL" : "DATABASE_URL");
            }}
          >
            <SelectTrigger><SelectValue placeholder="Choose a datastore…" /></SelectTrigger>
            <SelectContent>
              {availableDatastores.map((datastore) => (
                <SelectItem key={datastore.id} value={datastore.id}>
                  {datastore.name} ({datastore.kind}, {datastore.status})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Environment variable key">
          <Input
            className="font-mono text-sm"
            value={envKey}
            onChange={(event) => setEnvKey(event.target.value)}
            placeholder={selectedDatastore?.kind === "redis" ? "REDIS_URL" : "DATABASE_URL"}
          />
        </Field>
      </div>
      <div className="mt-3">
        <p className="text-xs font-medium">Inject into services</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {project.services.map((service) => (
            <label key={service.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={serviceIds.includes(service.id)}
                onChange={(event) =>
                  setServiceIds((current) =>
                    event.target.checked
                      ? [...current, service.id]
                      : current.filter((id) => id !== service.id)
                  )
                }
              />
              {service.name} ({service.kind})
            </label>
          ))}
        </div>
      </div>
      <Button
        type="button"
        className="mt-3"
        disabled={
          bind.isPending ||
          !datastoreId ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey.trim()) ||
          serviceIds.length === 0
        }
        onClick={() => bind.mutate()}
      >
        {bind.isPending ? "Binding…" : "Bind datastore"}
      </Button>
      <ConfirmDialog
        open={unbindId != null}
        onOpenChange={(nextOpen) => !nextOpen && setUnbindId(null)}
        title="Remove datastore binding"
        description={
          unbindTarget
            ? `${unbindTarget.datastore.name} will stop being injected into the selected services on the project's next release.`
            : ""
        }
        confirmLabel="Unbind"
        variant="destructive"
        onConfirm={() => {
          if (unbindTarget) unbind.mutate(unbindTarget);
          setUnbindId(null);
        }}
      />
    </div>
  );
}
