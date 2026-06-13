import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { api, apiGet, downloadPost } from "@/lib/api";
import type { BackupDestination } from "@/lib/types";

const DOWNLOAD = "__download__";
const PASSPHRASE_MIN = 8;

export function ExportDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const destQ = useQuery({
    queryKey: ["backup-destinations"],
    queryFn: () =>
      apiGet<{ destinations: BackupDestination[] }>("/api/backups/destinations"),
    enabled: open
  });

  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [target, setTarget] = useState<string>(DOWNLOAD);

  const reset = () => {
    setPassphrase("");
    setConfirm("");
    setIncludeSecrets(true);
    setTarget(DOWNLOAD);
  };

  const mismatch = confirm.length > 0 && passphrase !== confirm;
  const canExport =
    passphrase.length >= PASSPHRASE_MIN && passphrase === confirm;

  const exportMut = useMutation({
    mutationFn: async () => {
      const body = {
        passphrase,
        includeSecrets,
        destinationId: target === DOWNLOAD ? undefined : target
      };
      if (target === DOWNLOAD) {
        await downloadPost("/api/backups/export", body, "sohwe-backup.sohwe.json");
      } else {
        await api("/api/backups/export", {
          method: "POST",
          body: JSON.stringify(body)
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["bundles"] });
      toast.success(
        target === DOWNLOAD ? "Bundle downloaded" : "Bundle written to destination"
      );
      reset();
      onOpenChange(false);
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Export failed");
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export config bundle</DialogTitle>
          <DialogDescription>
            Exports every app's settings, volume definitions, and alert
            destinations. The passphrase encrypts env vars and signs the bundle —
            you need it again to restore. Keep it safe; it cannot be recovered.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Passphrase">
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={`At least ${PASSPHRASE_MIN} characters`}
            />
          </Field>
          <Field label="Confirm passphrase">
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          {mismatch ? (
            <p className="text-xs text-destructive">Passphrases do not match.</p>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border"
              checked={includeSecrets}
              onChange={(e) => setIncludeSecrets(e.target.checked)}
            />
            Include env var values (encrypted)
          </label>
          <Field label="Destination">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DOWNLOAD}>Download to this device</SelectItem>
                {(destQ.data?.destinations ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name} ({d.config.path})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canExport || exportMut.isPending}
            onClick={() => exportMut.mutate()}
          >
            {exportMut.isPending ? "Exporting…" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
