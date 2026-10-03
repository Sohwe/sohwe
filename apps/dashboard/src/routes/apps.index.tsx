import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Rocket } from "lucide-react";
import { AppCard } from "@/components/apps/AppCard";
import { CreateAppDialog } from "@/components/apps/CreateAppDialog";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, fetchMe } from "@/lib/api";
import { useBaseDomain } from "@/lib/config";
import { parseDeployLink, type DeployLinkPrefill } from "@/lib/deploy-link";
import { isAdmin } from "@/lib/roles";
import type { AppRow, Me } from "@/lib/types";

export function AppsListPage() {
  const [deployLink] = useState(() => parseDeployLink(window.location.search));
  const [createOpen, setCreateOpen] = useState(deployLink.kind === "valid");
  const [linkInitial, setLinkInitial] = useState<DeployLinkPrefill | undefined>(
    () => deployLink.kind === "valid" ? deployLink.value : undefined
  );
  const baseDomain = useBaseDomain();
  const q = useQuery({ queryKey: ["applications"], queryFn: () => api<AppRow[]>("/api/applications") });
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() });
  // Creating apps is admin-only server-side; members still see and deploy them.
  const canCreate = isAdmin(me);

  useEffect(() => {
    const onOpen = () => setCreateOpen(true);
    const ev = "sohwe:open-create-app" as const;
    window.addEventListener(ev, onOpen);
    return () => window.removeEventListener(ev, onOpen);
  }, []);

  return (
    <div>
      <PageHeader
        title="Applications"
        description={`Build, deploy, and manage services from Git. New apps receive a your-slug.${baseDomain} address automatically.`}
        actions={
          canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New app
            </Button>
          ) : undefined
        }
      />
      {deployLink.kind === "invalid" ? (
        <p className="mb-4 rounded-lg border border-destructive/50 p-3 text-sm text-destructive" role="alert">{deployLink.message}</p>
      ) : deployLink.kind === "valid" && me && !canCreate ? (
        <p className="mb-4 rounded-lg border p-3 text-sm text-muted-foreground" role="status">An owner or admin must sign in to use this deploy link.</p>
      ) : null}
      {canCreate ? (
        <CreateAppDialog
          key={linkInitial ? "deploy-link" : "new-app"}
          open={createOpen}
          initial={linkInitial}
          onOpenChange={(next) => {
            setCreateOpen(next);
            if (!next) setLinkInitial(undefined);
          }}
        />
      ) : null}
      {q.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-3 rounded-xl border border-border/80 bg-card p-5 shadow-panel">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </div>
      ) : null}
      {q.isError ? <p className="text-destructive">Failed to load applications.</p> : null}
      {q.data?.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title="No applications yet"
          description={
            canCreate
              ? "Connect a public Git URL and let Sohwe build and run it on your infrastructure."
              : "Nothing has been deployed here yet. Ask an admin to create the first application."
          }
          action={
            canCreate ? (
              <Button onClick={() => setCreateOpen(true)}>Create application</Button>
            ) : undefined
          }
        />
      ) : null}
      {q.data && q.data.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-1 xl:grid-cols-2">
          {q.data.map((a) => (
            <AppCard key={a.id} app={a} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
