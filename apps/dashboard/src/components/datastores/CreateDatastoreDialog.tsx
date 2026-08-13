import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
import type { Datastore } from "@/lib/types";

const SLUG_RE = /^[a-z0-9-]+$/;

/** Mirrors `POSTGRES_ENGINE_VERSIONS` / `REDIS_ENGINE_VERSIONS` in @sohwe/types. */
const ENGINE_VERSIONS: Record<"postgres" | "redis", string[]> = {
  postgres: ["16", "17"],
  redis: ["7"]
};

export function CreateDatastoreDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [kind, setKind] = useState<"postgres" | "redis">("postgres");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [engineVersion, setEngineVersion] = useState("16");

  const reset = () => {
    setKind("postgres");
    setName("");
    setSlug("");
    setEngineVersion("16");
  };

  const createMut = useMutation({
    mutationFn: () =>
      api<Datastore>("/api/datastores", {
        method: "POST",
        body: JSON.stringify({
          kind,
          name: name.trim(),
          slug: slug.trim(),
          engineVersion
        })
      }),
    onSuccess: (ds) => {
      void queryClient.invalidateQueries({ queryKey: ["datastores"] });
      toast.success(`Provisioning ${ds.name}…`);
      reset();
      onOpenChange(false);
      void navigate({ to: "/datastores/$datastoreId", params: { datastoreId: ds.id } });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to create datastore");
    }
  });

  const valid = name.trim().length > 0 && SLUG_RE.test(slug.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New datastore</DialogTitle>
          <DialogDescription>
            A managed {kind === "postgres" ? "Postgres" : "Redis"} container on
            this host with a persistent volume and generated credentials.
            Private by default — bind it to apps to use it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Kind">
            <Select
              value={kind}
              onValueChange={(v) => {
                const k = v as "postgres" | "redis";
                setKind(k);
                setEngineVersion(ENGINE_VERSIONS[k][0]!);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="postgres">PostgreSQL</SelectItem>
                <SelectItem value="redis">Redis</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSlug(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/(^-|-$)/g, "")
                );
              }}
              placeholder="Main database"
            />
          </Field>
          <Field label="Slug">
            <Input
              className="font-mono text-sm"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="main-db"
            />
          </Field>
          <Field label="Engine version">
            <Select value={engineVersion} onValueChange={setEngineVersion}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENGINE_VERSIONS[kind].map((v) => (
                  <SelectItem key={v} value={v}>
                    {kind}:{v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!valid || createMut.isPending}
            onClick={() => createMut.mutate()}
          >
            {createMut.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
