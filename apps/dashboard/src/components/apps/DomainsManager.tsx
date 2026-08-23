import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreateDomainSchema } from "@sohwe/types";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Plus,
  RefreshCw,
  Star,
  Trash2
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { api, apiGet, fetchMe } from "@/lib/api";
import { useAppConfig } from "@/lib/config";
import { isAdmin } from "@/lib/roles";
import { cn } from "@/lib/utils";
import type {
  AppDomain,
  AppRow,
  DnsInspection,
  DomainVerifyResult,
  Me
} from "@/lib/types";
import { DomainDnsPanel } from "./DomainDnsPanel";

// The one place custom domains are managed. Each row is a hostname the app
// answers on; expanding it shows where its DNS lives, the record it still
// needs, a link into that provider's console, and — where Sohwe has an API
// integration and a token — a button that writes the record for you.
//
// Deliberately its own tab rather than a field in the settings form: adding a
// domain is a multi-step job (claim it, point DNS at this host, wait for it to
// propagate, deploy) and it needs somewhere to report progress.

const STATUS: Record<
  NonNullable<AppDomain["lastStatus"]>,
  { label: string; variant: "success" | "warning" | "secondary" | "outline" }
> = {
  verified: { label: "DNS verified", variant: "success" },
  // Behind a proxy the origin is unknowable from outside, so this is neither a
  // pass nor a failure — the app may well be serving fine.
  proxied: { label: "Proxied", variant: "secondary" },
  mismatch: { label: "Points elsewhere", variant: "warning" },
  unresolved: { label: "No record yet", variant: "secondary" },
  unknown: { label: "Can't verify", variant: "outline" }
};

export function DomainsManager({ app }: { app: AppRow }) {
  const queryClient = useQueryClient();
  const { baseDomain, httpsEnabled } = useAppConfig();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() });
  const admin = isAdmin(me);

  const [hostname, setHostname] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AppDomain | null>(null);
  /** Fresh inspections keyed by domain id, from an add or a re-check. */
  const [inspections, setInspections] = useState<Record<string, DnsInspection>>({});

  const domainsQuery = useQuery({
    queryKey: ["app-domains", app.id],
    queryFn: () =>
      apiGet<{ domains: AppDomain[] }>(`/api/applications/${app.id}/domains`)
  });
  const domains = domainsQuery.data?.domains ?? [];

  /**
   * Validate as the user types, using the same schema the API enforces, so a
   * pasted URL is shown normalized before it is ever submitted.
   */
  const parsed = useMemo(() => {
    const trimmed = hostname.trim();
    if (trimmed === "") return null;
    return CreateDomainSchema.safeParse({ hostname: trimmed });
  }, [hostname]);
  const normalized = parsed?.success ? parsed.data.hostname : null;
  const hostnameError =
    parsed && !parsed.success
      ? (parsed.error.issues[0]?.message ?? "Not a valid hostname")
      : null;

  /** Refresh the domain list *and* the app row, whose primary URL may change. */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["app-domains", app.id] });
    void queryClient.invalidateQueries({ queryKey: ["applications"] });
  };

  const recordInspection = (result: DomainVerifyResult) => {
    setInspections((prev) => ({ ...prev, [result.domain.id]: result.dns }));
  };

  const addMut = useMutation({
    mutationFn: (host: string) =>
      api<DomainVerifyResult>(`/api/applications/${app.id}/domains`, {
        method: "POST",
        body: JSON.stringify({ hostname: host })
      }),
    onSuccess: (result) => {
      setHostname("");
      recordInspection(result);
      // Open it straight away: the next thing to do is almost always the DNS
      // record, and it is right there in the panel.
      setExpandedId(result.domain.id);
      refresh();
      toast.success(`${result.domain.hostname} added`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not add domain")
  });

  const verifyMut = useMutation({
    mutationFn: (domainId: string) =>
      api<DomainVerifyResult>(
        `/api/applications/${app.id}/domains/${domainId}/verify`,
        { method: "POST" }
      ),
    onSuccess: (result) => {
      recordInspection(result);
      refresh();
      const status = result.dns.status;
      if (status === "verified") toast.success(`${result.domain.hostname} points here`);
      else toast.message(STATUS[status].label, { description: result.domain.hostname });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "DNS check failed")
  });

  const primaryMut = useMutation({
    mutationFn: (domainId: string) =>
      api<{ domains: AppDomain[] }>(
        `/api/applications/${app.id}/domains/${domainId}/primary`,
        { method: "POST" }
      ),
    onSuccess: () => {
      refresh();
      toast.success("Primary domain updated");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update")
  });

  const removeMut = useMutation({
    mutationFn: (domainId: string) =>
      api<{ ok: boolean }>(`/api/applications/${app.id}/domains/${domainId}`, {
        method: "DELETE"
      }),
    onSuccess: () => {
      refresh();
      toast.success("Domain removed — deploy to stop serving it");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove")
  });

  const scheme = httpsEnabled ? "https" : "http";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Custom domains</CardTitle>
          <CardDescription>
            Hostnames this app answers on, in addition to{" "}
            <span className="font-mono text-xs">
              {app.slug}.{baseDomain}
            </span>
            . Each one needs a DNS record pointing at this host; Sohwe checks that for you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {admin && (
            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (normalized) addMut.mutate(normalized);
              }}
            >
              <div className="flex gap-2">
                <Input
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  placeholder="app.example.com"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={hostnameError ? true : undefined}
                  aria-label="Domain to add"
                />
                <Button
                  type="submit"
                  className="gap-1"
                  disabled={!normalized || addMut.isPending}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {addMut.isPending ? "Adding…" : "Add domain"}
                </Button>
              </div>
              {hostnameError ? (
                <p className="text-xs text-destructive">{hostnameError}</p>
              ) : normalized && normalized !== hostname.trim() ? (
                // Pasting a full URL is the common case; show what will be saved.
                <p className="text-xs text-muted-foreground">
                  Will be added as <span className="font-mono">{normalized}</span>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  A full URL works too — it is trimmed down to the hostname.
                </p>
              )}
            </form>
          )}

          {domainsQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Loading domains…</p>
          ) : domainsQuery.isError ? (
            <p className="text-sm text-destructive">
              {domainsQuery.error instanceof Error
                ? domainsQuery.error.message
                : "Could not load domains"}
            </p>
          ) : domains.length === 0 ? (
            <EmptyState
              title="No custom domains"
              description={
                admin
                  ? "Add one above, then point its DNS at this host."
                  : "An admin can add a custom domain for this app."
              }
            />
          ) : (
            <ul className="divide-y rounded-md border">
              {domains.map((d) => {
                const expanded = expandedId === d.id;
                const status = d.lastStatus ? STATUS[d.lastStatus] : null;
                return (
                  <li key={d.id}>
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        aria-label={expanded ? "Hide DNS details" : "Show DNS details"}
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : d.id)}
                      >
                        {expanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <a
                        className="font-mono text-sm hover:underline"
                        href={`${scheme}://${d.hostname}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {d.hostname}
                      </a>
                      {d.isPrimary && <Badge variant="outline">Primary</Badge>}
                      {status && <Badge variant={status.variant}>{status.label}</Badge>}

                      <div className="ml-auto flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Re-check DNS"
                          disabled={verifyMut.isPending}
                          onClick={() => {
                            setExpandedId(d.id);
                            verifyMut.mutate(d.id);
                          }}
                        >
                          <RefreshCw
                            className={cn(
                              "h-3.5 w-3.5",
                              verifyMut.isPending &&
                                verifyMut.variables === d.id &&
                                "animate-spin"
                            )}
                          />
                        </Button>
                        <Button
                          asChild
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title={`Open ${scheme}://${d.hostname}`}
                        >
                          <a
                            href={`${scheme}://${d.hostname}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </Button>
                        {admin && !d.isPrimary && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Make primary"
                            disabled={primaryMut.isPending}
                            onClick={() => primaryMut.mutate(d.id)}
                          >
                            <Star className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {admin && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            title="Remove domain"
                            onClick={() => setRemoving(d)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {expanded && (
                      <div className="border-t bg-muted/20 px-3 py-3">
                        <DomainDnsPanel
                          appId={app.id}
                          domain={d}
                          inspection={inspections[d.id] ?? null}
                          checking={verifyMut.isPending && verifyMut.variables === d.id}
                          onCheck={() => verifyMut.mutate(d.id)}
                          admin={admin}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {domains.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Routing changes take effect on the next deploy — the running container keeps
              its current hostnames until then.
              {!httpsEnabled && (
                <>
                  {" "}
                  HTTPS is off on this instance (
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                    SOHWE_HTTPS_ENABLED
                  </code>
                  ), so no certificate will be issued for these domains.
                </>
              )}
            </p>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.hostname ?? "domain"}`}
        description="The app stops answering on this hostname after its next deploy. The DNS record itself is left alone — remove it at your DNS provider if you no longer need it."
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={async () => {
          if (removing) await removeMut.mutateAsync(removing.id);
          setRemoving(null);
        }}
      />
    </div>
  );
}
