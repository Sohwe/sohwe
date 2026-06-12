import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { api, apiGet } from "@/lib/api";
import type { AlertDestination, AlertDestinationType } from "@/lib/types";

const TYPE_LABELS: Record<AlertDestinationType, string> = {
  slack: "Slack",
  discord: "Discord",
  generic: "Generic (JSON)"
};

export function AlertsManager({ appId }: { appId: string }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["app-alerts", appId],
    queryFn: () =>
      apiGet<{ destinations: AlertDestination[] }>(
        `/api/applications/${appId}/alert-destinations`
      )
  });

  const [type, setType] = useState<AlertDestinationType>("slack");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["app-alerts", appId] });

  const addMut = useMutation({
    mutationFn: () =>
      api(`/api/applications/${appId}/alert-destinations`, {
        method: "POST",
        body: JSON.stringify({ type, name: name.trim(), url: url.trim() })
      }),
    onSuccess: () => {
      setName("");
      setUrl("");
      void invalidate();
      toast.success("Alert destination added");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to add destination");
    }
  });

  const toggleMut = useMutation({
    mutationFn: (d: AlertDestination) =>
      api(`/api/applications/${appId}/alert-destinations/${d.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !d.enabled })
      }),
    onSuccess: () => void invalidate(),
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to update");
    }
  });

  const delMut = useMutation({
    mutationFn: (destId: string) =>
      api(`/api/applications/${appId}/alert-destinations/${destId}`, {
        method: "DELETE"
      }),
    onSuccess: () => {
      void invalidate();
      toast.success("Alert destination removed");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to remove");
    }
  });

  const canAdd = name.trim().length > 0 && /^https?:\/\//.test(url.trim());

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Crash alerts</CardTitle>
          <CardDescription>
            Webhooks called when this app's container crashes or is OOM-killed.
            Payloads contain only app metadata — never env var values.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {q.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : null}
          {q.isError ? (
            <p className="text-sm text-destructive">
              Could not load alert destinations.
            </p>
          ) : null}
          {q.data ? (
            <ul className="space-y-2">
              {q.data.destinations.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  No alert destinations configured.
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
                        {TYPE_LABELS[d.type]}
                      </span>
                      {!d.enabled ? (
                        <span className="text-xs text-muted-foreground">
                          disabled
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {d.url}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={toggleMut.isPending}
                      onClick={() => toggleMut.mutate(d)}
                    >
                      {d.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRemoveId(d.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2 sm:items-end">
            <Field label="Type">
              <Select
                value={type}
                onValueChange={(v) => setType(v as AlertDestinationType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="discord">Discord</SelectItem>
                  <SelectItem value="generic">Generic (JSON)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. #alerts channel"
              />
            </Field>
            <Field label="Webhook URL" className="sm:col-span-2">
              <Input
                className="font-mono text-sm"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/…"
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
        title="Remove alert destination"
        description="Stop sending crash alerts to this webhook?"
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
