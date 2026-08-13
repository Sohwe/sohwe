import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { api, apiGet } from "@/lib/api";
import type { AppRow, DatastoreDetail } from "@/lib/types";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function BindingsManager({ datastore }: { datastore: DatastoreDetail }) {
  const queryClient = useQueryClient();

  const appsQ = useQuery({
    queryKey: ["applications"],
    queryFn: () => apiGet<AppRow[]>("/api/applications")
  });

  const defaultKey = datastore.kind === "postgres" ? "DATABASE_URL" : "REDIS_URL";
  const [appId, setAppId] = useState("");
  const [envKey, setEnvKey] = useState(defaultKey);
  const [unbindId, setUnbindId] = useState<string | null>(null);

  const boundAppIds = new Set(datastore.bindings.map((b) => b.applicationId));
  const bindableApps = (appsQ.data ?? []).filter((a) => !boundAppIds.has(a.id));

  const bindMut = useMutation({
    mutationFn: () =>
      api(`/api/datastores/${datastore.id}/bindings`, {
        method: "POST",
        body: JSON.stringify({ applicationId: appId, envKey: envKey.trim() })
      }),
    onSuccess: () => {
      setAppId("");
      setEnvKey(defaultKey);
      void queryClient.invalidateQueries({ queryKey: ["datastore", datastore.id] });
      toast.success("App bound — takes effect on its next deploy");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to bind app");
    }
  });

  const unbindMut = useMutation({
    mutationFn: (bindingId: string) =>
      api(`/api/datastores/${datastore.id}/bindings/${bindingId}`, {
        method: "DELETE"
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["datastore", datastore.id] });
      toast.success("Binding removed");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to remove binding");
    }
  });

  const unbinding = datastore.bindings.find((b) => b.id === unbindId);

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bound apps</CardTitle>
          <CardDescription>
            Binding injects the connection URL into the app&apos;s encrypted env
            vars and attaches this datastore to the app&apos;s private network.
            Changes take effect on the app&apos;s next deploy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {datastore.bindings.length === 0 ? (
              <li className="text-sm text-muted-foreground">
                No apps bound yet.
              </li>
            ) : null}
            {datastore.bindings.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {b.appName}{" "}
                    <span className="font-mono text-xs text-muted-foreground">
                      /{b.appSlug}
                    </span>
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {b.envKeys.join(", ")}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setUnbindId(b.id)}
                >
                  Unbind
                </Button>
              </li>
            ))}
          </ul>

          <div className="grid gap-2 sm:grid-cols-2 sm:items-end">
            <Field label="Application">
              <Select value={appId} onValueChange={setAppId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an app…" />
                </SelectTrigger>
                <SelectContent>
                  {bindableApps.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Env var key">
              <Input
                className="font-mono text-sm"
                value={envKey}
                onChange={(e) => setEnvKey(e.target.value)}
                placeholder={defaultKey}
              />
            </Field>
            <Button
              type="button"
              className="w-fit"
              disabled={
                bindMut.isPending || !appId || !ENV_KEY_RE.test(envKey.trim())
              }
              onClick={() => bindMut.mutate()}
            >
              {bindMut.isPending ? "Binding…" : "Bind app"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={unbindId != null}
        onOpenChange={(o) => !o && setUnbindId(null)}
        title="Remove binding"
        description={
          unbinding
            ? `Removes ${unbinding.envKeys.join(", ")} from ${unbinding.appName}'s env vars — even if you have since changed the value — and detaches the datastore from its network on the next deploy.`
            : ""
        }
        confirmLabel="Unbind"
        variant="destructive"
        onConfirm={() => {
          if (unbindId) unbindMut.mutate(unbindId);
          setUnbindId(null);
        }}
      />
    </div>
  );
}
