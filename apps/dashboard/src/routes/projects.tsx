import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreateProjectSchema, normalizeHostname } from "@sohwe/types";
import { Boxes, Plus, Rocket, RotateCcw, Settings, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/PageHeader";
import { Field } from "@/components/common/Field";
import { EditProjectDialog } from "@/components/projects/EditProjectDialog";
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
import type { Me, ProjectRow } from "@/lib/types";

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
  envVars: string;
  buildArgs: string;
};

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
    buildMode: "dockerfile",
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
    envVars: "",
    buildArgs: ""
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
    envVars: variableLines(service.envVars),
    buildArgs: variableLines(service.buildArgs)
  };
}

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
  const [autoDeploy, setAutoDeploy] = useState(false);
  const [projectVariables, setProjectVariables] = useState("");
  const [services, setServices] = useState<ServiceDraft[]>(() => [makeServiceDraft()]);

  function updateService(key: string, patch: Partial<ServiceDraft>) {
    setServices((current) =>
      current.map((service) => (service.key === key ? { ...service, ...patch } : service))
    );
  }

  const create = useMutation({
    mutationFn: async () => {
      const payload = CreateProjectSchema.parse({
        name,
        slug,
        gitRepo: repo,
        gitBranch: branch,
        autoDeploy,
        envVars: variableLines(projectVariables),
        services: services.map(serviceInput)
      });
      return api<ProjectRow>("/api/projects", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      setName("");
      setSlug("");
      setRepo("");
      setBranch("main");
      setAutoDeploy(false);
      setProjectVariables("");
      setServices([makeServiceDraft()]);
      onOpenChange(false);
      toast.success("Project created");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not create project")
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Compose the services this repository needs. Every service is built from the same commit
            and released on one private project network.
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
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoDeploy}
              onChange={(event) => setAutoDeploy(event.target.checked)}
            />
            Deploy this project when its configured branch receives a push
          </label>

          <details className="rounded-md bg-muted/40 p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Shared runtime variables
            </summary>
            <div className="mt-3">
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

          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Services</p>
              <p className="text-xs text-muted-foreground">
                HTTP services are routed publicly; workers and release jobs remain private.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={services.length >= 32}
              onClick={() =>
                setServices((current) => [
                  ...current,
                  makeServiceDraft(
                    "worker",
                    current.filter((service) => service.kind === "worker").length + 1
                  )
                ])
              }
            >
              <Plus className="mr-2 h-4 w-4" /> Add service
            </Button>
          </div>

          <div className="space-y-4">
            {services.map((service, index) => {
              const hasAnotherRelease = services.some(
                (candidate) => candidate.kind === "release" && candidate.key !== service.key
              );
              return (
                <div key={service.key} className="rounded-lg border p-4">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">Service {index + 1}</p>
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

                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <Field label="Build mode">
                      <Select
                        value={service.buildMode}
                        onValueChange={(value) =>
                          updateService(service.key, {
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
                          updateService(service.key, { serviceDirectory: event.target.value })
                        }
                        placeholder="apps/api"
                        required
                      />
                    </Field>
                    <Field label="Workspace selector (optional)">
                      <Input
                        value={service.workspaceSelector}
                        onChange={(event) =>
                          updateService(service.key, { workspaceSelector: event.target.value })
                        }
                        placeholder="@acme/api"
                      />
                    </Field>
                    <Field label="Dockerfile path">
                      <Input
                        value={service.dockerfilePath}
                        onChange={(event) =>
                          updateService(service.key, { dockerfilePath: event.target.value })
                        }
                        placeholder="apps/api/Dockerfile"
                        required
                      />
                    </Field>
                    <Field label="Docker target (optional)">
                      <Input
                        value={service.dockerTarget}
                        onChange={(event) =>
                          updateService(service.key, { dockerTarget: event.target.value })
                        }
                        placeholder="runtime"
                      />
                    </Field>
                    <Field label="Shared image group (optional)">
                      <Input
                        value={service.imageGroup}
                        onChange={(event) =>
                          updateService(service.key, { imageGroup: event.target.value })
                        }
                        placeholder="backend"
                      />
                    </Field>
                  </div>

                  {service.kind === "http" ? (
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <Field label="Container port">
                        <Input
                          type="number"
                          min={1}
                          max={65535}
                          value={service.port}
                          onChange={(event) =>
                            updateService(service.key, { port: event.target.value })
                          }
                          required
                        />
                      </Field>
                      <Field label="Custom domains (comma-separated)" className="sm:col-span-2">
                        <Input
                          value={service.domains}
                          onChange={(event) =>
                            updateService(service.key, { domains: event.target.value })
                          }
                          placeholder="api.example.com, alternate.example.com"
                        />
                      </Field>
                    </div>
                  ) : null}

                  <details className="mt-4 rounded-md bg-muted/40 p-3">
                    <summary className="cursor-pointer text-sm font-medium">Advanced settings</summary>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
                      <Field label="Service runtime variables (KEY=value)">
                        <Textarea
                          value={service.envVars}
                          onChange={(event) =>
                            updateService(service.key, { envVars: event.target.value })
                          }
                          placeholder={"API_INTERNAL_URL=http://api:4000\nCONCURRENCY=2"}
                        />
                      </Field>
                      <Field label="Build arguments (KEY=value)">
                        <Textarea
                          value={service.buildArgs}
                          onChange={(event) =>
                            updateService(service.key, { buildArgs: event.target.value })
                          }
                          placeholder="PUBLIC_API_URL=https://api.example.com"
                        />
                        <span className="text-xs font-normal text-muted-foreground">
                          Build arguments can remain visible in image layers.
                        </span>
                      </Field>
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
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create project"}
          </Button>
        </form>
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

function ProjectCard({ project, canEdit }: { project: ProjectRow; canEdit: boolean }) {
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
          {canEdit ? (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Settings className="mr-2 h-4 w-4" /> Configure
            </Button>
          ) : null}
        </div>
        {project.releases[0]?.errorMessage ? (
          <p className="mt-3 text-sm text-destructive">{project.releases[0].errorMessage}</p>
        ) : null}
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
          <ProjectCard key={project.id} project={project} canEdit={isAdmin(me)} />
        ))}
      </div>
    </div>
  );
}
