import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, apiGet } from "@/lib/api";
import type { AppVolume } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";

const MOUNT_PATH_RE = /^\/[A-Za-z0-9._\-/]+$/;

export function VolumesManager({ appId, onChanged }: { appId: string; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["app-volumes", appId],
    queryFn: () => apiGet<{ volumes: AppVolume[] }>(`/api/applications/${appId}/volumes`)
  });
  const [mountPath, setMount] = useState("/data");
  const [sizeHint, setSizeHint] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);

  const addMut = useMutation({
    mutationFn: () => {
      const raw = sizeHint.trim();
      const n =
        raw === ""
          ? undefined
          : (() => {
              const v = Math.floor(Number(raw));
              if (!Number.isFinite(v) || v < 1) return undefined;
              return v;
            })();
      return api(`/api/applications/${appId}/volumes`, {
        method: "POST",
        body: JSON.stringify({ mountPath: mountPath.trim(), sizeBytes: n })
      });
    },
    onSuccess: () => {
      setSizeHint("");
      void queryClient.invalidateQueries({ queryKey: ["app-volumes", appId] });
      onChanged();
      toast.success("Volume added");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to add volume");
    }
  });

  const delMut = useMutation({
    mutationFn: (volumeId: string) =>
      api(`/api/applications/${appId}/volumes/${volumeId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["app-volumes", appId] });
      onChanged();
      toast.success("Volume removed");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to remove");
    }
  });

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Persistent volumes</CardTitle>
          <CardDescription>
            Data survives redeploys. Size is a display hint. Redeploy after adding or removing mounts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {q.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {q.isError ? <p className="text-sm text-destructive">Could not load volumes.</p> : null}
          {q.data ? (
            <ul className="space-y-2">
              {q.data.volumes.length === 0 ? (
                <li className="text-sm text-muted-foreground">No extra volumes. Default image FS only.</li>
              ) : null}
              {q.data.volumes.map((v) => (
                <li
                  key={v.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
                >
                  <div>
                    <span className="font-mono text-sm">{v.mountPath}</span>
                    {v.sizeBytes ? <span className="ml-2 text-xs text-muted-foreground">{v.sizeBytes} B hint</span> : null}
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setRemoveId(v.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2 sm:items-end">
            <Field label="Mount path in container">
              <Input
                className="font-mono text-sm"
                value={mountPath}
                onChange={(e) => setMount(e.target.value)}
                placeholder="/app/data"
              />
            </Field>
            <Field label="Size hint (bytes, optional)">
              <Input
                className="font-mono text-sm"
                value={sizeHint}
                onChange={(e) => setSizeHint(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="e.g. 1073741824"
                inputMode="numeric"
              />
            </Field>
            <Button
              type="button"
              className="w-fit"
              disabled={addMut.isPending || !MOUNT_PATH_RE.test(mountPath.trim())}
              onClick={() => {
                if (!MOUNT_PATH_RE.test(mountPath.trim()) || mountPath.includes("..")) return;
                addMut.mutate();
              }}
            >
              {addMut.isPending ? "Adding…" : "Add volume"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={removeId != null}
        onOpenChange={(o) => !o && setRemoveId(null)}
        title="Remove volume"
        description="Remove this mount and delete its Docker volume data for this app?"
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={() => {
          if (removeId) delMut.mutate(removeId);
          setRemoveId(null);
        }}
      />
    </div>
  );
}
