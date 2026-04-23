import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { AppCard } from "@/components/apps/AppCard";
import { CreateAppDialog } from "@/components/apps/CreateAppDialog";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { baseDomain } from "@/lib/constants";
import type { AppRow } from "@/lib/types";

export function AppsListPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const q = useQuery({ queryKey: ["applications"], queryFn: () => api<AppRow[]>("/api/applications") });

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
        description={`Deploy from public Git. Default URL: your-slug.${baseDomain} (optional custom domain per app).`}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New app
          </Button>
        }
      />
      <CreateAppDialog open={createOpen} onOpenChange={setCreateOpen} />
      {q.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-2 rounded-lg border border-border p-4">
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
          title="No applications yet"
          description="Connect a public Git URL and let Sohwe build and run it on your infrastructure."
          action={
            <Button onClick={() => setCreateOpen(true)}>Create application</Button>
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
