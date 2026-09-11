import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Eye, EyeOff, Globe, KeyRound, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { CopyButton } from "@/components/common/CopyButton";
import { Field } from "@/components/common/Field";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, apiGet } from "@/lib/api";
import type { DatastoreConnection, DatastoreDetail } from "@/lib/types";
import { BindingsManager } from "@/components/datastores/BindingsManager";
import {
  DatastoreKindBadge,
  DatastoreStatusBadge
} from "@/components/datastores/DatastoreStatusBadge";

export function DatastoreDetailPage() {
  const { datastoreId } = useParams({ strict: false }) as { datastoreId: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const q = useQuery({
    queryKey: ["datastore", datastoreId],
    queryFn: () => apiGet<DatastoreDetail>(`/api/datastores/${datastoreId}`),
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "provisioning" || s === "deleting" ? 2000 : false;
    }
  });

  // Connection info is revealed imperatively into local state, never the query
  // cache. The server audits every reveal.
  const [connection, setConnection] = useState<DatastoreConnection | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [publicOpen, setPublicOpen] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["datastore", datastoreId] });
    void queryClient.invalidateQueries({ queryKey: ["datastores"] });
  };

  const provisionMut = useMutation({
    mutationFn: () =>
      api(`/api/datastores/${datastoreId}/provision`, { method: "POST" }),
    onSuccess: () => {
      invalidate();
      toast.success("Provisioning…");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to provision");
    }
  });

  const rotateMut = useMutation({
    mutationFn: () =>
      api(`/api/datastores/${datastoreId}/rotate-password`, { method: "POST" }),
    onSuccess: () => {
      setConnection(null);
      invalidate();
      toast.success("Rotating password…");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to rotate password");
    }
  });

  const publicMut = useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/api/datastores/${datastoreId}/public-access`, {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      }),
    onSuccess: () => {
      setConnection(null);
      invalidate();
      toast.success("Public access updated");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to update access");
    }
  });

  const deleteMut = useMutation({
    mutationFn: () => api(`/api/datastores/${datastoreId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Deleting datastore…");
      void queryClient.invalidateQueries({ queryKey: ["datastores"] });
      void navigate({ to: "/datastores" });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  });

  const revealConnection = async () => {
    try {
      const c = await apiGet<DatastoreConnection>(
        `/api/datastores/${datastoreId}/connection`
      );
      setConnection(c);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read connection info");
    }
  };

  if (q.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (q.isError || !q.data) {
    return <p className="text-sm text-destructive">Could not load this datastore.</p>;
  }
  const ds = q.data;
  const isPublic = ds.publicPort != null;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/datastores"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Datastores
        </Link>
        <PageHeader
          className="mb-0"
          title={ds.name}
          description={`${ds.kind}:${ds.engineVersion} · container ${ds.containerState}`}
          actions={
            <>
              {ds.status === "idle" || ds.status === "error" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={provisionMut.isPending}
                  onClick={() => provisionMut.mutate()}
                >
                  <Play className="mr-2 h-4 w-4" />
                  Provision
                </Button>
              ) : null}
              {ds.status === "running" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={rotateMut.isPending}
                  onClick={() => setRotateOpen(true)}
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  Rotate password
                </Button>
              ) : null}
              <Button
                type="button"
                variant="destructive"
                disabled={ds.status === "deleting" || deleteMut.isPending}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </Button>
            </>
          }
        />
        <div className="mt-2 flex items-center gap-2">
          <DatastoreKindBadge kind={ds.kind} />
          <DatastoreStatusBadge status={ds.status} />
          {ds.errorMessage ? (
            <span className="text-xs text-destructive">{ds.errorMessage}</span>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connection</CardTitle>
          <CardDescription>
            Bound apps and project services reach this datastore privately at{" "}
            <span className="font-mono">{`sohwe-ds-${ds.slug}`}</span>. Revealing
            the credentials is recorded in the audit log.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!connection ? (
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              onClick={() => void revealConnection()}
            >
              <Eye className="mr-2 h-4 w-4" />
              Reveal connection info
            </Button>
          ) : (
            <div className="space-y-2">
              <ConnectionRow label="Internal URL" value={connection.url} />
              {connection.publicUrl ? (
                <ConnectionRow label="Public URL" value={connection.publicUrl} />
              ) : null}
              <ConnectionRow label="Password" value={connection.password} />
              {connection.username ? (
                <ConnectionRow label="User" value={connection.username} mono />
              ) : null}
              {connection.database ? (
                <ConnectionRow label="Database" value={connection.database} mono />
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConnection(null)}
              >
                <EyeOff className="mr-2 h-3.5 w-3.5" />
                Hide
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <DatastoreResourcesCard datastore={ds} onSaved={invalidate} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Networking</CardTitle>
          <CardDescription>
            {isPublic
              ? `Published on host port ${String(ds.publicPort)} — reachable from outside this server.`
              : "Private: reachable only by bound apps on their internal networks."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            disabled={
              publicMut.isPending ||
              ds.status === "provisioning" ||
              ds.status === "deleting"
            }
            onClick={() => {
              if (isPublic) publicMut.mutate(false);
              else setPublicOpen(true);
            }}
          >
            <Globe className="mr-2 h-4 w-4" />
            {isPublic ? "Disable public access" : "Enable public access"}
          </Button>
          {isPublic ? (
            <p className="text-xs text-muted-foreground">
              Traffic is plain TCP — the generated password is the only
              protection. Disable public access when you no longer need it.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <BindingsManager datastore={ds} />

      <ConfirmDialog
        open={publicOpen}
        onOpenChange={setPublicOpen}
        title="Enable public access"
        description="Publishes the database port on this server for external clients (your laptop, apps hosted elsewhere). Traffic is unencrypted TCP and the password is the only protection. The container restarts to apply the change."
        confirmLabel="Enable"
        onConfirm={() => publicMut.mutate(true)}
      />
      <ConfirmDialog
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        title="Rotate password"
        description="Generates a new password and updates the connection URL injected into bound apps. Re-deploy bound apps so they pick up the new URL; external clients need the new credentials immediately."
        confirmLabel="Rotate"
        onConfirm={() => rotateMut.mutate()}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete datastore"
        description={`Stops and removes the container AND deletes its Docker volume — all data in "${ds.name}" is destroyed permanently. Env vars injected into bound apps are left in place.`}
        confirmLabel="Delete forever"
        variant="destructive"
        onConfirm={() => deleteMut.mutate()}
      />
    </div>
  );
}

function DatastoreResourcesCard({
  datastore,
  onSaved
}: {
  datastore: DatastoreDetail;
  onSaved: () => void;
}) {
  const [memoryLimitMb, setMemoryLimitMb] = useState(
    datastore.memoryLimitMb == null ? "" : String(datastore.memoryLimitMb)
  );
  const [cpuLimit, setCpuLimit] = useState(
    datastore.cpuLimit == null ? "" : String(datastore.cpuLimit)
  );
  const update = useMutation({
    mutationFn: () =>
      api(`/api/datastores/${datastore.id}/resources`, {
        method: "PATCH",
        body: JSON.stringify({
          memoryLimitMb: memoryLimitMb.trim() ? Number(memoryLimitMb) : null,
          cpuLimit: cpuLimit.trim() ? Number(cpuLimit) : null
        })
      }),
    onSuccess: () => {
      onSaved();
      toast.success("Datastore resource limits updated");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Failed to update resources")
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Resources</CardTitle>
        <CardDescription>
          Limits apply immediately to a running container and to every future provision. Leave a
          field empty for unlimited.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Memory limit, MB">
            <Input
              type="number"
              min={16}
              max={65536}
              value={memoryLimitMb}
              onChange={(event) => setMemoryLimitMb(event.target.value)}
              placeholder="Unlimited"
            />
          </Field>
          <Field label="CPU limit">
            <Input
              type="number"
              min={0.1}
              max={64}
              step={0.1}
              value={cpuLimit}
              onChange={(event) => setCpuLimit(event.target.value)}
              placeholder="Unlimited"
            />
          </Field>
        </div>
        <Button type="button" disabled={update.isPending} onClick={() => update.mutate()}>
          {update.isPending ? "Saving…" : "Save resource limits"}
        </Button>
      </CardContent>
    </Card>
  );
}

function ConnectionRow({
  label,
  value,
  mono = true
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={mono ? "truncate font-mono text-xs" : "truncate text-sm"}>
          {value}
        </p>
      </div>
      <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}
