import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UpdateApplicationSchema, type ConfigField } from "@sohwe/types";
import { toast } from "sonner";
import { useRouter } from "@tanstack/react-router";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { AppRow, BuildMode } from "@/lib/types";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";

export function AppSettingsForm({ app, onDelete }: { app: AppRow; onDelete?: () => void }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [buildMode, setBuildMode] = useState<BuildMode>((app.buildMode as BuildMode) ?? "auto");
  const [buildCmd, setBuildCmd] = useState(app.buildCmd ?? "");
  const [startCmd, setStartCmd] = useState(app.startCmd ?? "");
  const [runtimeCmd, setRuntimeCmd] = useState(app.runtimeCmd ?? "");
  const [appDirectory, setAppDirectory] = useState(app.appDirectory ?? ".");
  const [dockerfilePath, setDockerfilePath] = useState(app.dockerfilePath ?? "Dockerfile");
  const [dockerTarget, setDockerTarget] = useState(app.dockerTarget ?? "");
  const [port, setPort] = useState(app.port);
  const [branch, setBranch] = useState(app.gitBranch);
  const [configPath, setConfigPath] = useState(app.configPath ?? "");
  const [configOverrides, setConfigOverrides] = useState<Set<ConfigField>>(() => new Set(app.configOverrides as ConfigField[]));
  const configQ = useQuery({
    queryKey: ["repository-config-preview", app.gitRepo, branch, configPath.trim(), app.configOverrides.includes("appDirectory") ? app.appDirectory : null],
    queryFn: () => api<{ configPath: string | null; resolved: import("@sohwe/types/config").ResolvedPlan }>("/api/repositories/inspect", {
      method: "POST",
      body: JSON.stringify({ gitRepo: app.gitRepo, branch, configPath: configPath.trim(), directory: app.configOverrides.includes("appDirectory") ? app.appDirectory : undefined })
    }),
    enabled: !!configPath.trim(),
    retry: false,
    staleTime: 60_000
  });
  function override(field: ConfigField) { setConfigOverrides((current) => new Set(current).add(field)); }
  function clearOverride(field: ConfigField) { setConfigOverrides((current) => { const next = new Set(current); next.delete(field); return next; }); }
  const filePlan = configPath.trim() ? configQ.data?.resolved.values : undefined;
  const shownBuildMode = !configOverrides.has("buildMode") && filePlan ? filePlan.buildMode : buildMode;
  const shownAppDirectory = !configOverrides.has("appDirectory") && filePlan ? filePlan.appDirectory : appDirectory;
  const shownBuildCmd = !configOverrides.has("buildCmd") && filePlan ? filePlan.buildCmd ?? "" : buildCmd;
  const shownStartCmd = !configOverrides.has("startCmd") && filePlan ? filePlan.startCmd ?? "" : startCmd;
  const shownDockerfilePath = !configOverrides.has("dockerfilePath") && filePlan ? filePlan.dockerfilePath : dockerfilePath;
  const shownDockerTarget = !configOverrides.has("dockerTarget") && filePlan ? filePlan.dockerTarget ?? "" : dockerTarget;
  const shownRuntimeCmd = !configOverrides.has("runtimeCmd") && filePlan ? filePlan.runtimeCmd ?? "" : runtimeCmd;
  const shownPort = !configOverrides.has("port") && filePlan ? filePlan.port : port;
  const [manualBranch, setManualBranch] = useState(false);
  const branchesQ = useQuery({
    queryKey: ["repository-branches", app.gitRepo],
    queryFn: () => api<{ branches: string[]; defaultBranch: string | null; truncated: boolean }>("/api/repositories/branches", {
      method: "POST",
      body: JSON.stringify({ gitRepo: app.gitRepo })
    }),
    staleTime: 60_000,
    retry: false
  });
  const branchChoices = branchesQ.data?.branches ?? [];
  const showManualBranch = manualBranch || branchesQ.isError || branchesQ.isSuccess && !branchChoices.includes(branch);
  const [memMb, setMemMb] = useState(app.memoryLimitMb != null ? String(app.memoryLimitMb) : "");
  const [cpuStr, setCpuStr] = useState(app.cpuLimit != null ? String(app.cpuLimit) : "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = useMutation({
    mutationFn: () => {
      const body = UpdateApplicationSchema.parse({
        buildMode,
        buildCmd: buildCmd ? buildCmd : null,
        startCmd: startCmd ? startCmd : null,
        runtimeCmd: runtimeCmd ? runtimeCmd : null,
        appDirectory,
        ...(configPath.trim() !== (app.configPath ?? "") ? { configPath: configPath.trim() || null } : {}),
        ...(configPath.trim() ? { configOverrides: [...configOverrides] } : {}),
        dockerfilePath,
        dockerTarget: dockerTarget ? dockerTarget : null,
        port,
        gitBranch: branch,
        memoryLimitMb: memMb.trim() === "" ? null : Number(memMb),
        cpuLimit: cpuStr.trim() === "" ? null : Number(cpuStr)
      });
      return api<AppRow>(`/api/applications/${app.id}`, { method: "PATCH", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      toast.success("Settings saved");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  });

  const deleteMut = useMutation({
    mutationFn: () => api<{ ok: boolean }>(`/api/applications/${app.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      toast.success("Application deleted");
      onDelete?.();
      void router.navigate({ to: "/apps" });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Build, runtime, and limits</CardTitle>
          <CardDescription>Save, then deploy to apply. Clear memory/CPU for unlimited.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Repository config file">
                <Input value={configPath} onChange={(e) => setConfigPath(e.target.value)} placeholder="sohwe.yaml or apps/api/sohwe.yaml" />
                <span className="text-xs text-muted-foreground">Opt in with a repository-relative path. Clear it to stop reading the file on future deploys.</span>
              </Field>
              {configPath.trim() ? <div className="text-xs text-muted-foreground">
                {configQ.isFetching ? "Reading repository config…" : configQ.isError ? <span className="text-destructive">Could not read this config or branch. Check the path and file.</span> : `Current file: ${configQ.data?.configPath ?? configPath}`}
                <p>On each deployment, Sohwe reads this file from the deployed commit. Saved overrides take precedence.</p>
              </div> : null}
            </div>
            {configPath.trim() ? <div className="rounded-md border border-border/70 p-3 text-xs">
              <p className="font-medium">Current file and detection preview</p>
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {(["appDirectory", "buildMode", "dockerfilePath", "dockerTarget", "buildCmd", "startCmd", "runtimeCmd", "port"] as const).map((field) => <div key={field} className="flex items-center gap-2">
                  <span>{field}: {configOverrides.has(field) ? "dashboard override" : configQ.data ? `${String(configQ.data.resolved.values[field] ?? "default")} (${configQ.data.resolved.sources[field]})` : "loading"}</span>
                  {configOverrides.has(field) ? <Button type="button" size="sm" variant="ghost" onClick={() => clearOverride(field)}>Clear override</Button> : null}
                </div>)}
              </div>
            </div> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Build mode">
                <Select value={shownBuildMode} onValueChange={(v) => { setBuildMode(v as BuildMode); override("buildMode"); }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">auto (Dockerfile → Nixpacks)</SelectItem>
                    <SelectItem value="dockerfile">dockerfile</SelectItem>
                    <SelectItem value="nixpacks">nixpacks</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Branch">
                {branchesQ.isSuccess && branchChoices.length > 0 ? (
                  <Select value={showManualBranch ? ":manual" : branch} onValueChange={(value) => {
                    if (value === ":manual") setManualBranch(true);
                    else { setBranch(value); setManualBranch(false); }
                  }}>
                    <SelectTrigger><SelectValue placeholder="Choose a branch" /></SelectTrigger>
                    <SelectContent>
                      {branchChoices.map((name) => <SelectItem key={name} value={name}>{name}{name === branchesQ.data.defaultBranch ? " (default)" : ""}</SelectItem>)}
                      <SelectItem value=":manual">Enter a branch manually…</SelectItem>
                    </SelectContent>
                  </Select>
                ) : branchesQ.isError || branchesQ.isSuccess ? null : (
                  <Select disabled><SelectTrigger><SelectValue placeholder="Loading branches…" /></SelectTrigger></Select>
                )}
                {showManualBranch || branchesQ.isSuccess && branchChoices.length === 0 ? (
                  <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Branch name" />
                ) : null}
                {branchesQ.isError ? <span className="text-xs text-muted-foreground">Could not load branches. Enter a branch name to continue.</span> : null}
                {branchesQ.data?.truncated ? <span className="text-xs text-muted-foreground">Showing the first 100 branches. Enter another branch manually if needed.</span> : null}
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="App directory (repository relative)">
                <Input value={shownAppDirectory} onChange={(e) => { setAppDirectory(e.target.value); override("appDirectory"); }} placeholder=". or apps/api" />
              </Field>
              <Field label="Build command (nixpacks override)">
                <Input value={shownBuildCmd} onChange={(e) => { setBuildCmd(e.target.value); override("buildCmd"); }} placeholder="(auto)" />
              </Field>
              <Field label="Start command (nixpacks override)">
                <Input value={shownStartCmd} onChange={(e) => { setStartCmd(e.target.value); override("startCmd"); }} placeholder="(auto)" />
              </Field>
            </div>
            {shownBuildMode !== "nixpacks" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Dockerfile path">
                  <Input
                    value={shownDockerfilePath}
                    onChange={(e) => { setDockerfilePath(e.target.value); override("dockerfilePath"); }}
                    placeholder="Dockerfile or apps/api/Dockerfile"
                  />
                </Field>
                <Field label="Docker target (optional)">
                  <Input
                    value={shownDockerTarget}
                    onChange={(e) => { setDockerTarget(e.target.value); override("dockerTarget"); }}
                    placeholder="api, worker, migrate…"
                  />
                </Field>
              </div>
            ) : null}
            <Field label="Container command override (optional)">
              <Input
                value={shownRuntimeCmd}
                onChange={(e) => { setRuntimeCmd(e.target.value); override("runtimeCmd"); }}
                placeholder="Use the image CMD"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Container port">
                <Input
                  type="number"
                  value={shownPort}
                  onChange={(e) => { setPort(Number(e.target.value)); override("port"); }}
                  min={1}
                  max={65535}
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Memory limit (MB)">
                <Input
                  type="number"
                  value={memMb}
                  onChange={(e) => setMemMb(e.target.value)}
                  min={16}
                  max={65536}
                  placeholder="Unlimited"
                />
              </Field>
              <Field label="CPU limit (cores)">
                <Input
                  type="number"
                  value={cpuStr}
                  onChange={(e) => setCpuStr(e.target.value)}
                  min={0.1}
                  max={64}
                  step="0.1"
                  placeholder="Unlimited"
                />
              </Field>
            </div>
            <div className="pt-1">
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? "Saving…" : "Save all settings"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>Delete this app and its Docker resources on this host.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)} disabled={deleteMut.isPending}>
            Delete application
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete application"
        description="This removes the app, containers, volumes, and network for this app on this host. This cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => void deleteMut.mutateAsync()}
      />
    </div>
  );
}
