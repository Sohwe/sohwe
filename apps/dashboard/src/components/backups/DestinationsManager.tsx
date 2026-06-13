import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { api, apiGet } from "@/lib/api";
import type { BackupDestination } from "@/lib/types";

export function DestinationsManager() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["backup-destinations"],
    queryFn: () =>
      apiGet<{ destinations: BackupDestination[] }>("/api/backups/destinations")
  });

  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["backup-destinations"] });

  const addMut = useMutation({
    mutationFn: () =>
      api("/api/backups/destinations", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          kind: "local",
          config: { path: path.trim() }
        })
      }),
    onSuccess: () => {
      setName("");
      setPath("");
      void invalidate();
      toast.success("Destination added");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to add destination");
    }
  });

  const delMut = useMutation({
    mutationFn: (id: string) =>
      api(`/api/backups/destinations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void invalidate();
      toast.success("Destination removed");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to remove");
    }
  });

  const canAdd = name.trim().length > 0 && path.trim().startsWith("/");

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Backup destinations</CardTitle>
          <CardDescription>
            Local paths the server writes bundles to. The path must be writable
            by the API container (e.g. a mounted host directory).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {q.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : null}
          {q.isError ? (
            <p className="text-sm text-destructive">
              Could not load destinations.
            </p>
          ) : null}
          {q.data ? (
            <ul className="space-y-2">
              {q.data.destinations.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  No destinations yet. Add one to schedule local exports, or use
                  Download below.
                </li>
              ) : null}
              {q.data.destinations.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{d.name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        local
                      </span>
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {d.config.path}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRemoveId(d.id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2 sm:items-end">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. nightly-local"
              />
            </Field>
            <Field label="Path">
              <Input
                className="font-mono text-sm"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/var/sohwe/backups"
              />
            </Field>
            <Button
              type="button"
              className="w-fit"
              disabled={addMut.isPending || !canAdd}
              onClick={() => addMut.mutate()}
            >
              {addMut.isPending ? "Adding…" : "Add destination"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={removeId != null}
        onOpenChange={(o) => !o && setRemoveId(null)}
        title="Remove destination"
        description="Existing bundle records keep their history. Future exports to this destination stop."
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
