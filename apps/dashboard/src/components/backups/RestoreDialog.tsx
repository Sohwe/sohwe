import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { api } from "@/lib/api";
import type {
  RestorePreflight,
  RestoreResult,
  SlugCollisionPolicy
} from "@/lib/types";

const POLICY_HELP: Record<SlugCollisionPolicy, string> = {
  rename: "Keep existing apps; restore colliding apps under a new slug.",
  overwrite: "Replace existing apps that share a slug with the bundled config.",
  skip: "Leave existing apps untouched; only restore non-colliding apps."
};

export function RestoreDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [bundle, setBundle] = useState<Record<string, unknown> | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [preflight, setPreflight] = useState<RestorePreflight | null>(null);
  const [policy, setPolicy] = useState<SlugCollisionPolicy>("rename");

  const reset = () => {
    setBundle(null);
    setPassphrase("");
    setPreflight(null);
    setPolicy("rename");
    if (fileRef.current) fileRef.current.value = "";
  };

  const onFile = async (file: File | undefined) => {
    setPreflight(null);
    if (!file) {
      setBundle(null);
      return;
    }
    try {
      const text = await file.text();
      setBundle(JSON.parse(text) as Record<string, unknown>);
    } catch {
      setBundle(null);
      toast.error("That file is not valid JSON");
    }
  };

  const preflightMut = useMutation({
    mutationFn: () =>
      api<RestorePreflight>("/api/backups/restore/preflight", {
        method: "POST",
        body: JSON.stringify({ bundle, passphrase })
      }),
    onSuccess: (data) => setPreflight(data),
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Could not read bundle");
    }
  });

  const applyMut = useMutation({
    mutationFn: () =>
      api<RestoreResult>("/api/backups/restore/apply", {
        method: "POST",
        body: JSON.stringify({ bundle, passphrase, collisionPolicy: policy })
      }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      const dsTotal =
        r.datastoresCreated + r.datastoresRenamed + r.datastoresOverwritten;
      toast.success(
        `Restored: ${r.created} created, ${r.renamed} renamed, ${r.overwritten} overwritten, ${r.skipped} skipped` +
          (dsTotal > 0 || r.datastoresSkipped > 0
            ? ` · ${dsTotal} datastore${dsTotal === 1 ? "" : "s"} (idle, provision to start)`
            : "")
      );
      reset();
      onOpenChange(false);
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Restore failed");
    }
  });

  const collisions =
    (preflight?.apps.filter((a) => a.collides).length ?? 0) +
    (preflight?.datastores.filter((d) => d.collides).length ?? 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Restore from bundle</DialogTitle>
          <DialogDescription>
            Restored apps are created in an idle state — nothing deploys and no
            certificates are requested until you deploy them. Enter the same
            passphrase used when the bundle was exported.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Bundle file (.sohwe.json)">
            <Input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </Field>
          <Field label="Passphrase">
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setPreflight(null);
              }}
            />
          </Field>

          {!preflight ? (
            <Button
              type="button"
              variant="secondary"
              className="w-fit"
              disabled={!bundle || passphrase.length === 0 || preflightMut.isPending}
              onClick={() => preflightMut.mutate()}
            >
              {preflightMut.isPending ? "Checking…" : "Check bundle"}
            </Button>
          ) : null}

          {preflight ? (
            <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">
                From <span className="font-medium text-foreground">{preflight.sourceOrgName}</span>{" "}
                · {new Date(preflight.createdAt).toLocaleString()} ·{" "}
                {preflight.includesSecrets ? "includes env vars" : "config only"}
              </p>
              <ul className="space-y-1">
                {preflight.apps.length === 0 ? (
                  <li className="text-sm text-muted-foreground">
                    Bundle contains no apps.
                  </li>
                ) : null}
                {preflight.apps.map((a) => (
                  <li
                    key={a.slug}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <span className="font-medium">
                      {a.name}{" "}
                      <span className="font-mono text-xs text-muted-foreground">
                        /{a.slug}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{a.volumeCount} vol · {a.alertCount} alerts · {a.envKeyCount} env · {a.buildArgKeyCount} build</span>
                      {a.collides ? (
                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">
                          slug exists
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              {preflight.datastores.length > 0 ? (
                <ul className="space-y-1 border-t border-border/60 pt-2">
                  {preflight.datastores.map((d) => (
                    <li
                      key={d.slug}
                      className="flex flex-wrap items-center justify-between gap-2 text-sm"
                    >
                      <span className="font-medium">
                        {d.name}{" "}
                        <span className="font-mono text-xs text-muted-foreground">
                          {d.kind}:{d.engineVersion} /{d.slug}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>
                          datastore · {d.bindingCount} binding{d.bindingCount === 1 ? "" : "s"}
                        </span>
                        {d.collides ? (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">
                            slug exists
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {collisions > 0 ? (
                <Field label={`Collision policy (${collisions} slug${collisions === 1 ? "" : "s"} already exist)`}>
                  <Select
                    value={policy}
                    onValueChange={(v) => setPolicy(v as SlugCollisionPolicy)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rename">Rename</SelectItem>
                      <SelectItem value="overwrite">Overwrite</SelectItem>
                      <SelectItem value="skip">Skip</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              <p className="text-xs text-muted-foreground">{POLICY_HELP[policy]}</p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!preflight || applyMut.isPending}
            onClick={() => applyMut.mutate()}
          >
            {applyMut.isPending ? "Restoring…" : "Restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
