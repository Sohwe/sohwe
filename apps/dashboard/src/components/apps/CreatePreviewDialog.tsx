import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { missingRequiredVariables } from "@sohwe/types/required-variables";
import type { VariableEntry } from "@sohwe/types";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { AppRow, RepositoryInspection } from "@/lib/types";
import { InitialVariablesEditor, type InitialVariablesEditorHandle } from "./InitialVariablesEditor";

export function CreatePreviewDialog({ parent, open, onOpenChange }: { parent: AppRow; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const variablesEditor = useRef<InitialVariablesEditorHandle>(null);
  const [branch, setBranch] = useState("");
  const [inspectedBranch, setInspectedBranch] = useState("");
  const [variables, setVariables] = useState<VariableEntry[]>([]);
  const [saved, setSaved] = useState<AppRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const branches = useQuery({
    queryKey: ["repository-branches", parent.gitRepo],
    queryFn: () => api<{ branches: string[] }>("/api/repositories/branches", { method: "POST", body: JSON.stringify({ gitRepo: parent.gitRepo }) }),
    retry: false
  });
  const inspection = useQuery({
    queryKey: ["preview-inspection", parent.id, inspectedBranch],
    queryFn: () => api<RepositoryInspection>("/api/repositories/inspect", { method: "POST", body: JSON.stringify({ gitRepo: parent.gitRepo, branch: inspectedBranch, configPath: parent.configPath ?? undefined, directory: parent.configOverrides.includes("appDirectory") ? parent.appDirectory : undefined }) }),
    enabled: !!inspectedBranch,
    retry: false
  });
  const required = inspection.data?.config?.application.variables?.filter((item) => item.required) ?? [];
  const displayed = [...variables];
  for (const item of required) if (!displayed.some((entry) => entry.key === item.key)) displayed.push({ key: item.key, value: "", scope: item.scope });
  const deploy = useMutation({
    mutationFn: (app: AppRow) => api<{ deployment: { id: string } }>(`/api/applications/${app.id}/deploy`, { method: "POST" }),
    onSuccess: (result, app) => {
      onOpenChange(false);
      toast.success("Preview deploy started");
      void navigate({ to: "/apps/$appId/deployments/$deploymentId", params: { appId: app.id, deploymentId: result.deployment.id } });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not start preview deployment")
  });
  const create = useMutation({
    mutationFn: (entries: VariableEntry[]) => api<AppRow>(`/api/applications/${parent.id}/previews`, { method: "POST", body: JSON.stringify({ branch, variables: entries }) }),
    onSuccess: (app) => {
      setSaved(app);
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      deploy.mutate(app);
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not create preview")
  });
  const pending = create.isPending || deploy.isPending;
  return <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Preview a branch</DialogTitle><DialogDescription>The preview gets its own app URL and container. No runtime or build variable values are copied from {parent.name}.</DialogDescription></DialogHeader>
      {saved ? <div className="space-y-3 text-sm"><p><strong>{saved.name}</strong> was saved. Retry uses this preview.</p>{error ? <p className="text-destructive" role="alert">{error}</p> : null}<div className="flex gap-2"><Button disabled={pending} onClick={() => { setError(null); deploy.mutate(saved); }}>Retry deploy</Button><Button variant="outline" onClick={() => { onOpenChange(false); void navigate({ to: "/apps/$appId/overview", params: { appId: saved.id } }); }}>Open preview</Button></div></div> :
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          if (inspectedBranch !== branch || !inspection.data || inspection.isFetching) { setError("Inspect this branch before creating a preview."); return; }
          const collected = variablesEditor.current?.collect() ?? { vars: displayed };
          if ("error" in collected) { setError(collected.error); return; }
          if (inspection.data.config) {
            const runtime = Object.fromEntries(collected.vars.filter((entry) => entry.scope !== "build").map((entry) => [entry.key, entry.value]));
            const build = Object.fromEntries(collected.vars.filter((entry) => entry.scope !== "runtime").map((entry) => [entry.key, entry.value]));
            const missing = missingRequiredVariables(inspection.data.config, runtime, build);
            if (missing.length) { setError(`Set required preview variables: ${missing.join(", ")}`); return; }
          }
          setError(null);
          create.mutate(collected.vars);
        }}>
          <Field label="Preview branch"><Input value={branch} onChange={(event) => { setBranch(event.target.value); setInspectedBranch(""); }} list="preview-branch-options" required placeholder="feature/my-change" /><datalist id="preview-branch-options">{branches.data?.branches.map((name) => <option key={name} value={name} />)}</datalist></Field>
          <Button type="button" variant="outline" disabled={!branch.trim() || inspection.isFetching} onClick={() => setInspectedBranch(branch.trim())}>Inspect branch</Button>
          {inspection.isFetching ? <p className="text-xs text-muted-foreground" role="status">Inspecting branch…</p> : null}
          {inspection.isError ? <p className="text-xs text-destructive" role="alert">Could not inspect this branch. Check its name and repository access.</p> : null}
          {inspection.data && inspectedBranch === branch ? <p className="text-xs text-muted-foreground">Commit {inspection.data.commitSha.slice(0, 12)} · {inspection.data.configPath ?? "Repository detection"}. Review preview settings and variables before deploying.</p> : null}
          {inspection.data && inspectedBranch === branch ? <InitialVariablesEditor ref={variablesEditor} value={displayed} onChange={setVariables} disabled={pending} /> : null}
          {required.length ? <p className="text-xs text-muted-foreground">Required: {required.map((item) => `${item.key} (${item.scope})`).join(", ")}</p> : null}
          {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
          <div className="flex justify-end gap-2"><Button type="submit" disabled={pending || !inspection.data || inspectedBranch !== branch}>{create.isPending ? "Creating…" : "Create and deploy preview"}</Button><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button></div>
        </form>}
    </DialogContent>
  </Dialog>;
}
