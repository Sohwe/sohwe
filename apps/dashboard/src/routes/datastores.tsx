import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { apiGet } from "@/lib/api";
import type { Datastore } from "@/lib/types";
import { CreateDatastoreDialog } from "@/components/datastores/CreateDatastoreDialog";
import {
  DatastoreKindBadge,
  DatastoreStatusBadge
} from "@/components/datastores/DatastoreStatusBadge";

export function DatastoresPage() {
  const [createOpen, setCreateOpen] = useState(false);

  const q = useQuery({
    queryKey: ["datastores"],
    queryFn: () => apiGet<{ datastores: Datastore[] }>("/api/datastores"),
    // Keep the list live while anything is provisioning or deleting.
    refetchInterval: (query) => {
      const rows = query.state.data?.datastores ?? [];
      return rows.some(
        (d) => d.status === "provisioning" || d.status === "deleting"
      )
        ? 2000
        : false;
    }
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Datastores"
        description="Managed Postgres and Redis on this host. Private by default — bind a datastore to apps to inject its connection URL."
        actions={
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New datastore
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All datastores</CardTitle>
          <CardDescription>
            Each datastore is a Sohwe-managed container with a persistent
            volume. Deleting one destroys its data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : null}
          {q.isError ? (
            <p className="text-sm text-destructive">Could not load datastores.</p>
          ) : null}
          {q.data ? (
            <ul className="space-y-2">
              {q.data.datastores.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  No datastores yet.
                </li>
              ) : null}
              {q.data.datastores.map((d) => (
                <li key={d.id}>
                  <Link
                    to="/datastores/$datastoreId"
                    params={{ datastoreId: d.id }}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 transition-colors hover:bg-accent"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <DatastoreKindBadge kind={d.kind} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{d.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {d.kind}:{d.engineVersion} · /{d.slug}
                          {d.publicPort != null ? ` · public :${d.publicPort}` : ""}
                        </p>
                      </div>
                    </div>
                    <DatastoreStatusBadge status={d.status} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <CreateDatastoreDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
