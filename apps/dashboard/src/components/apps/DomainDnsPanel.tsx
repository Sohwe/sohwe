import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, Trash2, Zap } from "lucide-react";
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
import { CopyButton } from "@/components/common/CopyButton";
import { api, apiGet, fetchMe } from "@/lib/api";
import { isAdmin } from "@/lib/roles";
import type {
  AppRow,
  DnsApplyResult,
  DnsCredentialInfo,
  DnsInspection,
  Me
} from "@/lib/types";

// Custom domain DNS assist (Phase 8): shows where the domain's DNS zone lives,
// whether it points at this instance yet, the exact record to add, a deep link
// to the provider's console — and, for Cloudflare with an org token configured,
// a one-click apply. Renders nothing until the app has a saved custom domain.

const STATUS_BADGE: Record<
  DnsInspection["status"],
  { label: string; variant: "success" | "warning" | "secondary" | "outline" }
> = {
  verified: { label: "DNS verified", variant: "success" },
  mismatch: { label: "Points elsewhere", variant: "warning" },
  unresolved: { label: "No record yet", variant: "secondary" },
  unknown: { label: "Can't verify", variant: "outline" }
};

export function DomainDnsPanel({ app }: { app: AppRow }) {
  const domain = app.domain;
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() });
  const admin = isAdmin(me);

  const inspect = useQuery({
    queryKey: ["dns-inspect", domain],
    queryFn: () => apiGet<DnsInspection>(`/api/dns/inspect?domain=${encodeURIComponent(domain!)}`),
    enabled: !!domain,
    staleTime: 30_000,
    retry: false
  });

  const cloudflareDetected = inspect.data?.provider?.apiSupported === true;

  const creds = useQuery({
    queryKey: ["dns-credentials"],
    queryFn: () => apiGet<{ credentials: DnsCredentialInfo[] }>("/api/dns/credentials"),
    // The endpoint is admin-and-above; a member request would just 403.
    enabled: admin && cloudflareDetected,
    staleTime: 30_000
  });
  const hasCloudflareToken = creds.data?.credentials.some((c) => c.provider === "cloudflare") ?? false;

  const saveToken = useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>(`/api/dns/credentials/cloudflare`, {
        method: "PUT",
        body: JSON.stringify({ token: token.trim() })
      }),
    onSuccess: () => {
      setToken("");
      toast.success("Cloudflare token verified and saved");
      void queryClient.invalidateQueries({ queryKey: ["dns-credentials"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save token")
  });

  const removeToken = useMutation({
    mutationFn: () => api<{ ok: boolean }>(`/api/dns/credentials/cloudflare`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Cloudflare token removed");
      void queryClient.invalidateQueries({ queryKey: ["dns-credentials"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove token")
  });

  const applyRecord = useMutation({
    mutationFn: () => api<DnsApplyResult>(`/api/applications/${app.id}/dns/apply`, { method: "POST" }),
    onSuccess: (r) => {
      toast.success(
        `Record ${r.action}: A ${r.record.name} → ${r.record.value}${r.proxied ? " (proxied)" : ""}`
      );
      void queryClient.invalidateQueries({ queryKey: ["dns-inspect", domain] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not apply record")
  });

  if (!domain) return null;

  const d = inspect.data;
  const status = d ? STATUS_BADGE[d.status] : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Domain DNS</CardTitle>
            <CardDescription>
              Where <span className="font-mono">{domain}</span> is hosted and whether it points here yet.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {status && <Badge variant={status.variant}>{status.label}</Badge>}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="Re-check DNS"
              disabled={inspect.isFetching}
              onClick={() => void inspect.refetch()}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${inspect.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {inspect.isPending && <p className="text-sm text-muted-foreground">Checking DNS…</p>}
        {inspect.isError && (
          <p className="text-sm text-destructive">
            {inspect.error instanceof Error ? inspect.error.message : "DNS check failed"}
          </p>
        )}

        {d && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {d.provider ? (
                <>
                  <span className="text-muted-foreground">DNS hosted at</span>
                  <span className="font-medium">{d.provider.name}</span>
                  {d.provider.url && (
                    <Button asChild variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs">
                      <a href={d.provider.url} target="_blank" rel="noreferrer">
                        Open DNS console <ExternalLink className="h-3 w-3" />
                      </a>
                    </Button>
                  )}
                </>
              ) : d.nameservers.length > 0 ? (
                <span className="text-muted-foreground">
                  Unrecognized DNS host — nameservers:{" "}
                  <span className="font-mono text-xs">{d.nameservers.join(", ")}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">
                  No nameservers found — is the domain registered?
                </span>
              )}
            </div>

            {d.record ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <span className="text-xs text-muted-foreground">Required record</span>
                <Badge variant="outline">{d.record.type}</Badge>
                <span className="font-mono text-xs">{d.record.name}</span>
                <CopyButton text={d.record.name} label="Copy name" />
                <span className="text-muted-foreground">→</span>
                <span className="font-mono text-xs">{d.record.value}</span>
                <CopyButton text={d.record.value} label="Copy value" />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Could not resolve this instance's public IP from its base domain, so no record value can
                be suggested yet.
              </p>
            )}

            {d.status === "mismatch" && (
              <p className="text-xs text-muted-foreground">
                Currently resolves to <span className="font-mono">{d.resolvedIps.join(", ")}</span>.
                {d.provider?.id === "cloudflare" &&
                  " If the record is proxied through Cloudflare (orange cloud), traffic may still reach this host — Sohwe cannot see the origin behind the proxy."}
              </p>
            )}

            {admin && cloudflareDetected && (
              <div className="border-t pt-3">
                {hasCloudflareToken ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="gap-1"
                      disabled={applyRecord.isPending || !d.record}
                      onClick={() => applyRecord.mutate()}
                    >
                      <Zap className="h-3.5 w-3.5" />
                      {applyRecord.isPending ? "Applying…" : "Add record automatically"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1 text-muted-foreground"
                      disabled={removeToken.isPending}
                      onClick={() => removeToken.mutate()}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Remove token
                    </Button>
                  </div>
                ) : (
                  <form
                    className="space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (token.trim()) saveToken.mutate();
                    }}
                  >
                    <p className="text-xs text-muted-foreground">
                      Paste a Cloudflare API token scoped to this zone (Zone → DNS → Edit) and Sohwe can
                      add the record for you. Create one at{" "}
                      <a
                        className="underline underline-offset-2"
                        href="https://dash.cloudflare.com/profile/api-tokens"
                        target="_blank"
                        rel="noreferrer"
                      >
                        dash.cloudflare.com/profile/api-tokens
                      </a>
                      . Stored encrypted; used only to manage DNS records.
                    </p>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="Cloudflare API token"
                        autoComplete="off"
                      />
                      <Button type="submit" size="sm" disabled={saveToken.isPending || !token.trim()}>
                        {saveToken.isPending ? "Verifying…" : "Save token"}
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
