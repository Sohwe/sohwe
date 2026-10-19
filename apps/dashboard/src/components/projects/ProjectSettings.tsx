import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreateServiceSchema } from "@sohwe/types";
import { toast } from "sonner";
import { api, apiGet, fetchMe } from "@/lib/api";
import { activeRelease, useProject } from "@/lib/projects";
import { isAdmin } from "@/lib/roles";
import type { Me, ProjectRow } from "@/lib/types";
import {
  EditProjectDialog,
  ProjectDatastoreBindings,
} from "./EditProjectDialog";
import { VariablesManager } from "@/components/apps/VariablesManager";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function AdminOnly({ children }: { children: ReactNode }) {
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => fetchMe<Me | null>(),
  });
  return isAdmin(me) ? (
    children
  ) : (
    <p className="text-sm text-muted-foreground">
      An owner or admin account is required to manage this section.
    </p>
  );
}

function AddService({ project }: { project: ProjectRow }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [kind, setKind] = useState<"http" | "worker" | "release">("worker");
  const [dockerfile, setDockerfile] = useState("Dockerfile");
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("3000");
  const [command, setCommand] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api(`/api/projects/${project.id}/services`, {
        method: "POST",
        body: JSON.stringify(
          CreateServiceSchema.parse({
            name,
            slug,
            kind,
            buildMode: "dockerfile",
            dockerfilePath: dockerfile,
            dockerTarget: target || undefined,
            port: kind === "http" ? Number(port) : undefined,
            runtimeCmd: command || undefined,
          }),
        ),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["project"] });
      setName("");
      setSlug("");
      toast.success(
        "Service added. Configure its variables and release the project to start it.",
      );
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <details className="rounded-xl border bg-card p-5">
      <summary className="cursor-pointer text-sm font-semibold">
        Add a service
      </summary>
      <form
        className="mt-4 grid gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <Field label="Service name">
          <Input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Service slug">
          <Input
            required
            pattern="[a-z0-9-]+"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
        </Field>
        <Field label="Service type">
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="http">HTTP (public)</option>
            <option value="worker">Worker (private)</option>
            <option
              value="release"
              disabled={project.services.some(
                (service) => service.kind === "release",
              )}
            >
              Release job (one-shot)
            </option>
          </select>
        </Field>
        <Field label="Dockerfile path">
          <Input
            required
            value={dockerfile}
            onChange={(event) => setDockerfile(event.target.value)}
          />
        </Field>
        <Field label="Docker target (optional)">
          <Input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </Field>
        {kind === "http" ? (
          <Field label="Container port">
            <Input
              type="number"
              min={1}
              max={65535}
              required
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </Field>
        ) : null}
        <Field label="Runtime command (optional)">
          <Input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Leave empty to use image CMD"
          />
        </Field>
        <div className="sm:col-span-2">
          <Button
            disabled={
              mutation.isPending ||
              project.releases.some((release) => activeRelease(release.status))
            }
            type="submit"
          >
            {mutation.isPending ? "Adding…" : "Add service"}
          </Button>
        </div>
      </form>
    </details>
  );
}

function SharedVariables({ project }: { project: ProjectRow }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["project-variable-previews", project.id],
    queryFn: () =>
      apiGet<{ project: { key: string; preview: string }[] }>(
        `/api/projects/${project.id}/variable-previews`,
      ),
  });
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [remove, setRemove] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (patch: { set?: Record<string, string>; unset?: string[] }) =>
      api(`/api/projects/${project.id}/variables`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      setKey("");
      setValue("");
      void client.invalidateQueries({
        queryKey: ["project-variable-previews", project.id],
      });
      toast.success(
        "Shared variables saved. Release the project to apply them.",
      );
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Shared runtime variables</CardTitle>
        <p className="text-sm text-muted-foreground">
          Inherited by every service. Service variables override shared values.
          Saved immediately and applied on the next release.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load variables.{" "}
            <button className="underline" onClick={() => void query.refetch()}>
              Retry
            </button>
          </p>
        ) : query.isPending ? (
          <p>Loading variables…</p>
        ) : query.data?.project.length ? (
          <ul className="divide-y">
            {query.data.project.map((item) => (
              <li
                key={item.key}
                className="flex items-center justify-between gap-2 py-2 text-sm"
              >
                <span className="min-w-0 break-all font-mono">
                  {item.key}{" "}
                  <span className="text-muted-foreground">{item.preview}</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => setRemove(item.key)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No shared variables.</p>
        )}
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({ set: { [key]: value } });
          }}
        >
          <Field label="Key">
            <Input
              required
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <Field label="Value">
            <Input
              type="password"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={mutation.isPending || !key}>
            Add / update variable
          </Button>
        </form>
        <ConfirmDialog
          open={remove !== null}
          onOpenChange={(open) => !open && setRemove(null)}
          title="Remove shared variable"
          description={`Remove ${remove ?? "this variable"} from every service that inherits it on the next release?`}
          confirmLabel="Remove"
          variant="destructive"
          onConfirm={() => {
            if (remove) mutation.mutate({ unset: [remove] });
          }}
        />
      </CardContent>
    </Card>
  );
}

export function ProjectSettingsPage() {
  const { data: project } = useProject();
  if (!project) return null;
  return (
    <AdminOnly>
      <div className="space-y-5">
        <EditProjectDialog
          key={project.id}
          project={project}
          open
          inline
          onOpenChange={() => {}}
        />
        <AddService project={project} />
      </div>
    </AdminOnly>
  );
}
export function ProjectVariablesPage() {
  const { data: project } = useProject();
  if (!project) return null;
  return (
    <AdminOnly>
      <div className="space-y-5">
        <SharedVariables project={project} />
        {project.services.map((service) => (
          <Card key={service.id}>
            <CardHeader>
              <CardTitle className="text-base">
                {service.name}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  ({service.slug})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <VariablesManager
                path={`/api/services/${service.id}/scoped-variables`}
                onChanged={() => {}}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </AdminOnly>
  );
}
export function ProjectDatastoresPage() {
  const { data: project } = useProject();
  return project ? (
    <AdminOnly>
      <ProjectDatastoreBindings project={project} />
    </AdminOnly>
  ) : null;
}
