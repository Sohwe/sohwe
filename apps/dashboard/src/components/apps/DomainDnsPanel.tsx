import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/common/CopyButton";
import { api, apiGet } from "@/lib/api";
import type {
  AppDomain,
  DnsApplyResult,
  DnsCredentialInfo,
  DnsInspection,
  DnsProviderOption
} from "@/lib/types";

// The DNS half of one custom domain: where its zone is hosted, whether it
// points here yet, the exact record it needs, a deep link into that provider's
// console — and, where Sohwe has an API integration and the org has a token,
// a button that writes the record without leaving the dashboard.
//
// Rendered inside an expanded row of `DomainsManager`, which owns the domain
// list and the re-check mutation; this component only reports.

export function DomainDnsPanel({
  appId,
  domain,
  inspection,
  checking,
  onCheck,
  admin
}: {
  appId: string;
  domain: AppDomain;
  /** Latest inspection, or null until this domain has been checked. */
  inspection: DnsInspection | null;
  checking: boolean;
  onCheck: () => void;
  admin: boolean;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");

  const providerId = inspection?.provider?.id ?? null;
  const canAutoApply = inspection?.provider?.apiSupported === true;

  // Token help text is served by the API so the dashboard does not carry a
  // second copy of the provider list.
  const providers = useQuery({
    queryKey: ["dns-providers"],
    queryFn: () => apiGet<{ providers: DnsProviderOption[] }>("/api/dns/providers"),
    enabled: canAutoApply,
    staleTime: Infinity
  });
  const providerOption = providers.data?.providers.find((p) => p.id === providerId);

  const creds = useQuery({
    queryKey: ["dns-credentials"],
    queryFn: () =>
      apiGet<{ credentials: DnsCredentialInfo[] }>("/api/dns/credentials"),
    // The endpoint is admin-and-above; a member request would just 403.
    enabled: admin && canAutoApply,
    staleTime: 30_000
  });
  const hasToken =
    creds.data?.credentials.some((c) => c.provider === providerId) ?? false;

  const saveToken = useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>(`/api/dns/credentials/${providerId ?? ""}`, {
        method: "PUT",
        body: JSON.stringify({ token: token.trim() })
      }),
    onSuccess: () => {
      setToken("");
      toast.success(`${providerOption?.label ?? "Provider"} token verified and saved`);
      void queryClient.invalidateQueries({ queryKey: ["dns-credentials"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save token")
  });

  const removeToken = useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>(`/api/dns/credentials/${providerId ?? ""}`, {
        method: "DELETE"
      }),
    onSuccess: () => {
      toast.success("Token removed");
      void queryClient.invalidateQueries({ queryKey: ["dns-credentials"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove token")
  });

  const applyRecord = useMutation({
    mutationFn: () =>
      api<DnsApplyResult>(
        `/api/applications/${appId}/domains/${domain.id}/dns/apply`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      toast.success(
        `Record ${r.action}: A ${r.record.name} → ${r.record.value}${r.proxied ? " (proxied)" : ""}`
      );
      // DNS was just changed; re-check rather than leave a stale status badge.
      onCheck();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not apply record")
  });

  if (!inspection) {
    return (
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          {checking ? "Checking DNS…" : "This domain has not been checked yet."}
        </p>
        {!checking && (
          <Button type="button" variant="outline" size="sm" className="h-7 gap-1" onClick={onCheck}>
            <RefreshCw className="h-3 w-3" /> Check now
          </Button>
        )}
      </div>
    );
  }

  const d = inspection;

  return (
    <div className="space-y-3">
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
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
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
          Could not resolve this instance's public IP from its base domain, so no record
          value can be suggested yet.
        </p>
      )}

      {d.status === "mismatch" && (
        <p className="text-xs text-muted-foreground">
          Currently resolves to <span className="font-mono">{d.resolvedIps.join(", ")}</span>.
          {d.provider?.id === "cloudflare" &&
            " If the record is proxied through Cloudflare (orange cloud), traffic may still reach this host — Sohwe cannot see the origin behind the proxy."}
        </p>
      )}

      {admin && canAutoApply && providerId && (
        <div className="border-t pt-3">
          {hasToken ? (
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
                Paste {providerOption?.tokenScope ?? "an API token"} and Sohwe can add the
                record for you.
                {providerOption && (
                  <>
                    {" "}
                    Create one at{" "}
                    <a
                      className="underline underline-offset-2"
                      href={providerOption.tokenUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {new URL(providerOption.tokenUrl).host}
                    </a>
                    .
                  </>
                )}{" "}
                Stored encrypted for the whole organization; used only to manage DNS records.
              </p>
              <div className="flex gap-2">
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={`${providerOption?.label ?? "Provider"} API token`}
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
    </div>
  );
}
