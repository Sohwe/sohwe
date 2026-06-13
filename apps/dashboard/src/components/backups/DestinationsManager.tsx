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
import { describeDestinationConfig, type BackupDestination } from "@/lib/types";

type Kind = "local" | "s3";

const EMPTY_S3 = {
  bucket: "",
  region: "",
  endpoint: "",
  prefix: "",
  forcePathStyle: false,
  accessKeyId: "",
  secretAccessKey: ""
};

export function DestinationsManager() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["backup-destinations"],
    queryFn: () =>
      apiGet<{ destinations: BackupDestination[] }>("/api/backups/destinations")
  });

  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("local");
  const [path, setPath] = useState("");
  const [s3, setS3] = useState({ ...EMPTY_S3 });
  const [removeId, setRemoveId] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["backup-destinations"] });

  const resetForm = () => {
    setName("");
    setPath("");
    setS3({ ...EMPTY_S3 });
    setKind("local");
  };

  const addMut = useMutation({
    mutationFn: () => {
      const body =
        kind === "local"
          ? { name: name.trim(), kind, config: { path: path.trim() } }
          : {
              name: name.trim(),
              kind,
              config: {
                bucket: s3.bucket.trim(),
                region: s3.region.trim(),
                ...(s3.endpoint.trim() ? { endpoint: s3.endpoint.trim() } : {}),
                ...(s3.prefix.trim() ? { prefix: s3.prefix.trim() } : {}),
                forcePathStyle: s3.forcePathStyle
              },
              credentials: {
                accessKeyId: s3.accessKeyId.trim(),
                secretAccessKey: s3.secretAccessKey
              }
            };
      return api("/api/backups/destinations", {
        method: "POST",
        body: JSON.stringify(body)
      });
    },
    onSuccess: () => {
      resetForm();
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

  const canAdd =
    name.trim().length > 0 &&
    (kind === "local"
      ? path.trim().startsWith("/")
      : s3.bucket.trim().length > 0 &&
        s3.region.trim().length > 0 &&
        s3.accessKeyId.trim().length > 0 &&
        s3.secretAccessKey.length > 0);

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Backup destinations</CardTitle>
          <CardDescription>
            Where the server writes bundles. Local paths must be writable by the
            API container; S3 works with any S3-compatible provider (AWS, MinIO,
            R2, Spaces). Credentials are encrypted at rest and never returned.
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
                  No destinations yet. Add one to write or schedule exports, or
                  use Download below.
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
                        {d.kind}
                      </span>
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {describeDestinationConfig(d)}
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

          <div className="space-y-3 rounded-md border border-border/60 p-3">
            <div className="grid gap-2 sm:grid-cols-2 sm:items-end">
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. nightly-offsite"
                />
              </Field>
              <Field label="Type">
                <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">Local path</SelectItem>
                    <SelectItem value="s3">S3-compatible</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {kind === "local" ? (
              <Field label="Path">
                <Input
                  className="font-mono text-sm"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/var/sohwe/backups"
                />
              </Field>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Bucket">
                  <Input
                    value={s3.bucket}
                    onChange={(e) => setS3({ ...s3, bucket: e.target.value })}
                    placeholder="my-backups"
                  />
                </Field>
                <Field label="Region">
                  <Input
                    value={s3.region}
                    onChange={(e) => setS3({ ...s3, region: e.target.value })}
                    placeholder="us-east-1"
                  />
                </Field>
                <Field label="Endpoint (optional)">
                  <Input
                    value={s3.endpoint}
                    onChange={(e) => setS3({ ...s3, endpoint: e.target.value })}
                    placeholder="https://s3.example.com"
                  />
                </Field>
                <Field label="Prefix (optional)">
                  <Input
                    className="font-mono text-sm"
                    value={s3.prefix}
                    onChange={(e) => setS3({ ...s3, prefix: e.target.value })}
                    placeholder="sohwe/"
                  />
                </Field>
                <Field label="Access key ID">
                  <Input
                    value={s3.accessKeyId}
                    onChange={(e) =>
                      setS3({ ...s3, accessKeyId: e.target.value })
                    }
                    autoComplete="off"
                  />
                </Field>
                <Field label="Secret access key">
                  <Input
                    type="password"
                    value={s3.secretAccessKey}
                    onChange={(e) =>
                      setS3({ ...s3, secretAccessKey: e.target.value })
                    }
                    autoComplete="off"
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm text-muted-foreground sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={s3.forcePathStyle}
                    onChange={(e) =>
                      setS3({ ...s3, forcePathStyle: e.target.checked })
                    }
                  />
                  Force path-style addressing (often required for MinIO and
                  other non-AWS providers)
                </label>
              </div>
            )}

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
        description="Existing bundle records keep their history, and schedules using it are removed. Future exports to this destination stop."
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
