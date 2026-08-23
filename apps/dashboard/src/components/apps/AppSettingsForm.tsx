import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UpdateApplicationSchema } from "@sohwe/types";
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
  const [port, setPort] = useState(app.port);
  const [branch, setBranch] = useState(app.gitBranch);
  const [memMb, setMemMb] = useState(app.memoryLimitMb != null ? String(app.memoryLimitMb) : "");
  const [cpuStr, setCpuStr] = useState(app.cpuLimit != null ? String(app.cpuLimit) : "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = useMutation({
    mutationFn: () => {
      const body = UpdateApplicationSchema.parse({
        buildMode,
        buildCmd: buildCmd ? buildCmd : null,
        startCmd: startCmd ? startCmd : null,
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
              <Field label="Build mode">
                <Select value={buildMode} onValueChange={(v) => setBuildMode(v as BuildMode)}>
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
                <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Build command (nixpacks override)">
                <Input value={buildCmd} onChange={(e) => setBuildCmd(e.target.value)} placeholder="(auto)" />
              </Field>
              <Field label="Start command (nixpacks override)">
                <Input value={startCmd} onChange={(e) => setStartCmd(e.target.value)} placeholder="(auto)" />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Container port">
                <Input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
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
