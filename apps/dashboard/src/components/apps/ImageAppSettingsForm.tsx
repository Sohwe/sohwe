import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { UpdateApplicationSchema } from "@sohwe/types";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";

export function ImageAppSettingsForm({ app, onDelete }: { app: AppRow; onDelete?: () => void }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [imageRef, setImageRef] = useState(app.imageRef ?? "");
  const [port, setPort] = useState(app.port);
  const [runtimeCmd, setRuntimeCmd] = useState(app.runtimeCmd ?? "");
  const [memory, setMemory] = useState(app.memoryLimitMb?.toString() ?? "");
  const [cpu, setCpu] = useState(app.cpuLimit?.toString() ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = useMutation({
    mutationFn: () => api<AppRow>(`/api/applications/${app.id}`, { method: "PATCH", body: JSON.stringify(UpdateApplicationSchema.parse({ imageRef, port, runtimeCmd: runtimeCmd || null, memoryLimitMb: memory ? Number(memory) : null, cpuLimit: cpu ? Number(cpu) : null })) }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["applications"] }); toast.success("Image settings saved; redeploy to apply"); },
    onError: (cause) => toast.error(cause instanceof Error ? cause.message : "Could not save image settings")
  });
  const remove = useMutation({
    mutationFn: () => api<{ ok: boolean }>(`/api/applications/${app.id}`, { method: "DELETE" }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["applications"] }); onDelete?.(); void router.navigate({ to: "/apps" }); },
    onError: (cause) => toast.error(cause instanceof Error ? cause.message : "Could not delete application")
  });
  return <div className="space-y-4">
    <Card>
      <CardHeader><CardTitle className="text-base">Image and runtime</CardTitle><CardDescription>Pull a public image on each deploy. Sohwe pins the pulled image ID for rollback.</CardDescription></CardHeader>
      <CardContent><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}>
        <Field label="Public image reference"><Input value={imageRef} onChange={(event) => setImageRef(event.target.value)} required spellCheck={false} /></Field>
        <Field id="container-port" label="Container port"><Input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} required /></Field>
        <Field id="runtime-command" label="Command override (optional)"><Input value={runtimeCmd} onChange={(event) => setRuntimeCmd(event.target.value)} placeholder="Use image CMD" /></Field>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Memory limit (MB)"><Input type="number" min={16} max={65536} value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="Unlimited" /></Field><Field label="CPU limit (cores)"><Input type="number" min={0.1} max={64} step={0.1} value={cpu} onChange={(event) => setCpu(event.target.value)} placeholder="Unlimited" /></Field></div>
        <Button type="submit" disabled={update.isPending}>{update.isPending ? "Saving…" : "Save settings"}</Button>
      </form></CardContent>
    </Card>
    <Card className="border-destructive/40"><CardHeader><CardTitle className="text-destructive">Danger zone</CardTitle></CardHeader><CardContent><Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>Delete application</Button></CardContent></Card>
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete application" description="This removes the app and its Docker resources. This cannot be undone." confirmLabel="Delete" variant="destructive" onConfirm={() => void remove.mutateAsync()} />
  </div>;
}
