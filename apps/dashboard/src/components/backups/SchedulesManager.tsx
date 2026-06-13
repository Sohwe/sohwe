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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { api, apiGet } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import {
  describeDestinationConfig,
  type BackupDestination,
  type BackupSchedule
} from "@/lib/types";

const PASSPHRASE_MIN = 8;

const CRON_PRESETS = [
  { label: "Daily 3am", cron: "0 3 * * *" },
  { label: "Every 6h", cron: "0 */6 * * *" },
  { label: "Weekly (Sun 3am)", cron: "0 3 * * 0" },
  { label: "Hourly", cron: "0 * * * *" }
];

export function SchedulesManager() {
  const queryClient = useQueryClient();

  const schedulesQ = useQuery({
    queryKey: ["backup-schedules"],
    queryFn: () =>
      apiGet<{ schedules: BackupSchedule[] }>("/api/backups/schedules")
  });
  const destQ = useQuery({
    queryKey: ["backup-destinations"],
    queryFn: () =>
      apiGet<{ destinations: BackupDestination[] }>("/api/backups/destinations")
  });

  const [destinationId, setDestinationId] = useState("");
  const [cron, setCron] = useState("0 3 * * *");
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [retention, setRetention] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["backup-schedules"] });

  const resetForm = () => {
    setDestinationId("");
    setCron("0 3 * * *");
    setIncludeSecrets(true);
    setPassphrase("");
    setRetention("");
  };

  const addMut = useMutation({
    mutationFn: () => {
      const retentionCount = retention.trim() ? Number(retention.trim()) : undefined;
      return api("/api/backups/schedules", {
        method: "POST",
        body: JSON.stringify({
          destinationId,
          cron: cron.trim(),
          includeSecrets,
          passphrase,
          ...(retentionCount ? { retentionCount } : {})
        })
      });
    },
    onSuccess: () => {
      resetForm();
      void invalidate();
      toast.success("Schedule created");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to create schedule");
    }
  });

  const toggleMut = useMutation({
    mutationFn: (s: BackupSchedule) =>
      api(`/api/backups/schedules/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !s.enabled })
      }),
    onSuccess: () => void invalidate(),
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to update schedule");
    }
  });

  const delMut = useMutation({
    mutationFn: (id: string) =>
      api(`/api/backups/schedules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void invalidate();
      toast.success("Schedule removed");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to remove");
    }
  });

  const destinations = destQ.data?.destinations ?? [];
  const passphraseOk = !includeSecrets || passphrase.length >= PASSPHRASE_MIN;
  // A passphrase is always needed: it signs the bundle even without secrets.
  const canAdd =
    destinationId.length > 0 &&
    cron.trim().length > 0 &&
    passphrase.length >= PASSPHRASE_MIN;

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scheduled exports</CardTitle>
          <CardDescription>
            Automatically export to a destination on a cron schedule. The
            passphrase signs (and, with env vars, encrypts) each bundle and is
            stored encrypted — keep a copy, it is required to restore. Retention
            keeps only the newest N bundles from a schedule.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {schedulesQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : null}
          {schedulesQ.isError ? (
            <p className="text-sm text-destructive">Could not load schedules.</p>
          ) : null}
          {schedulesQ.data ? (
            <ul className="space-y-2">
              {schedulesQ.data.schedules.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  No schedules yet.
                </li>
              ) : null}
              {schedulesQ.data.schedules.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{s.cron}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {s.destinationName ?? "destination"}
                      </span>
                      {!s.enabled ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          paused
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {s.includeSecrets ? "env vars" : "config only"}
                      {s.retentionCount
                        ? ` · keep ${s.retentionCount}`
                        : " · keep all"}
                      {" · last run "}
                      {s.lastRunAt ? formatRelativeTime(s.lastRunAt) : "never"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={toggleMut.isPending}
                      onClick={() => toggleMut.mutate(s)}
                    >
                      {s.enabled ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRemoveId(s.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="space-y-3 rounded-md border border-border/60 p-3">
            <div className="grid gap-2 sm:grid-cols-2 sm:items-end">
              <Field label="Destination">
                <Select value={destinationId} onValueChange={setDestinationId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a destination" />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.length === 0 ? (
                      <SelectItem value="__none__" disabled>
                        Add a destination first
                      </SelectItem>
                    ) : null}
                    {destinations.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name} ({describeDestinationConfig(d)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Schedule (cron)">
                <Input
                  className="font-mono text-sm"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 3 * * *"
                />
              </Field>
            </div>
            <div className="flex flex-wrap gap-1">
              {CRON_PRESETS.map((p) => (
                <Button
                  key={p.cron}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setCron(p.cron)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 sm:items-end">
              <Field label="Passphrase">
                <Input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={`At least ${PASSPHRASE_MIN} characters`}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Retention (keep newest N, optional)">
                <Input
                  type="number"
                  min={1}
                  value={retention}
                  onChange={(e) => setRetention(e.target.value)}
                  placeholder="e.g. 7"
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={includeSecrets}
                onChange={(e) => setIncludeSecrets(e.target.checked)}
              />
              Include encrypted env vars
            </label>
            {!passphraseOk ? (
              <p className="text-xs text-destructive">
                Passphrase must be at least {PASSPHRASE_MIN} characters.
              </p>
            ) : null}
            <Button
              type="button"
              className="w-fit"
              disabled={addMut.isPending || !canAdd}
              onClick={() => addMut.mutate()}
            >
              {addMut.isPending ? "Creating…" : "Create schedule"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={removeId != null}
        onOpenChange={(o) => !o && setRemoveId(null)}
        title="Remove schedule"
        description="Future automatic exports stop. Bundles already written to the destination are kept."
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
