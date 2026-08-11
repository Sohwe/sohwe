import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Lock,
  RefreshCw,
  Unplug
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { CopyButton } from "@/components/common/CopyButton";
import { PageHeader } from "@/components/common/PageHeader";
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
import { Field } from "@/components/common/Field";
import { api, apiGet } from "@/lib/api";
import { formatRelativeTime, shortCommitSha } from "@/lib/format";
import type { GitHubAppStatus, GitHubRepo, WebhookDelivery } from "@/lib/types";

/**
 * The manifest flow needs a real browser form POST to github.com, so "Connect"
 * navigates to an API route that renders a self-submitting form rather than
 * doing anything over fetch.
 */
function startConnect(org: string): void {
  const query = org.trim() ? `?org=${encodeURIComponent(org.trim())}` : "";
  window.location.href = `/api/github/manifest/new${query}`;
}

/** One-shot toast for the `?installed=1` / `?error=…` callback redirects. */
function useCallbackNotice(onHandled: () => void): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const installed = params.get("installed");
    const pending = params.get("pending");
    const error = params.get("error");
    if (!installed && !pending && !error) return;

    if (installed) toast.success("GitHub App installed");
    else if (pending) toast.info("Installation is waiting for an org owner to approve it");
    else if (error === "bad_installation") {
      toast.error("That installation does not belong to this instance's GitHub App");
    } else if (error === "not_connected") {
      toast.error("No GitHub App is connected yet");
    } else toast.error("GitHub setup did not complete");

    window.history.replaceState({}, "", window.location.pathname);
    onHandled();
  }, [onHandled]);
}

function ConnectCard({ status }: { status: GitHubAppStatus }) {
  const [org, setOrg] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connect GitHub</CardTitle>
        <CardDescription>
          Sohwe creates a GitHub App that belongs to you. GitHub generates the
          private key and webhook secret; this instance stores them encrypted and
          never sends them anywhere else.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status.publicUrlConfigured ? (
          <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="space-y-1">
              <p className="font-medium">
                SOHWE_PUBLIC_URL is not set — using {status.publicUrl}
              </p>
              <p className="text-muted-foreground">
                This address is baked into the app's webhook URL when GitHub
                creates it. If it is wrong, pushes will never reach this
                instance and you will have to recreate the app. Set
                SOHWE_PUBLIC_URL in <code>/etc/sohwe/sohwe.env</code> first.
              </p>
            </div>
          </div>
        ) : null}

        <div className="grid gap-2 text-sm">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <span className="text-muted-foreground">Webhook URL</span>
            <span className="flex min-w-0 items-center gap-1">
              <code className="truncate text-xs">{status.webhookUrl}</code>
              <CopyButton text={status.webhookUrl} />
            </span>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="GitHub organization (optional — leave blank for your personal account)">
            <Input
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="my-org"
            />
          </Field>
          <Button type="button" onClick={() => startConnect(org)}>
            <GitBranch className="mr-2 h-4 w-4" />
            Create GitHub App
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          You will review the permissions on GitHub (read repository contents and
          metadata, write commit statuses), then pick which repositories to
          share.
        </p>
      </CardContent>
    </Card>
  );
}

function RepositoryList() {
  const reposQ = useQuery({
    queryKey: ["github", "repositories"],
    queryFn: () => apiGet<{ repositories: GitHubRepo[] }>("/api/github/repositories")
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Shared repositories</CardTitle>
        <CardDescription>
          Repositories this installation can read. Change the selection on GitHub
          to add or remove entries.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {reposQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : null}
        {reposQ.isError ? (
          <p className="text-sm text-destructive">
            {reposQ.error instanceof Error
              ? reposQ.error.message
              : "Could not load repositories."}
          </p>
        ) : null}
        {reposQ.data ? (
          reposQ.data.repositories.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No repositories shared with this installation yet.
            </p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {reposQ.data.repositories.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <code className="truncate">{r.fullName}</code>
                    {r.private ? (
                      <Badge variant="outline" className="shrink-0 gap-1">
                        <Lock className="h-3 w-3" />
                        private
                      </Badge>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {r.defaultBranch}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

const OUTCOME_STYLE: Record<
  WebhookDelivery["outcome"],
  { label: string; className: string }
> = {
  accepted: { label: "Deployed", className: "text-emerald-500" },
  ignored: { label: "No action", className: "text-muted-foreground" },
  rejected: { label: "Rejected", className: "text-destructive" },
  error: { label: "Error", className: "text-destructive" }
};

/**
 * Recent webhook deliveries.
 *
 * Without this, a push that does not deploy gives the operator nothing to go
 * on: GitHub reports a 2xx, Sohwe does nothing, and the reason (wrong secret,
 * untracked branch, auto-deploy off) lives only in the API's stdout.
 */
function DeliveryLog() {
  const q = useQuery({
    queryKey: ["github", "deliveries"],
    queryFn: () => apiGet<{ deliveries: WebhookDelivery[] }>("/api/github/deliveries"),
    refetchInterval: 15_000
  });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">Recent deliveries</CardTitle>
          <CardDescription>
            What GitHub sent this instance and what Sohwe did with it. An empty
            list after a push means the delivery never arrived — check the
            webhook URL and that this host is reachable from the internet.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          title="Refresh"
          onClick={() => void q.refetch()}
        >
          <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {q.isError ? (
          <p className="text-sm text-destructive">Could not load deliveries.</p>
        ) : null}
        {q.data ? (
          q.data.deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No deliveries recorded yet. GitHub sends a ping as soon as the app
              is installed.
            </p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {q.data.deliveries.map((d) => {
                const style = OUTCOME_STYLE[d.outcome];
                return (
                  <li key={d.id} className="py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-xs font-medium ${style.className}`}>
                        {style.label}
                      </span>
                      <code className="text-xs">{d.event || "—"}</code>
                      {d.repoFullName ? (
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                          {d.repoFullName}
                          {d.branch ? `@${d.branch}` : ""}
                          {d.commitSha ? ` ${shortCommitSha(d.commitSha)}` : ""}
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {formatRelativeTime(d.createdAt)}
                      </span>
                    </div>
                    {d.detail ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{d.detail}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function ConnectedCard({ status }: { status: GitHubAppStatus }) {
  const queryClient = useQueryClient();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const app = status.app!;

  const disconnect = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; deleteAppUrl: string }>("/api/github/app", {
        method: "DELETE"
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["github"] });
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      toast.success("Disconnected", {
        description:
          "Auto-deploy was turned off for all apps. Delete the app on GitHub too if you no longer want it.",
        action: {
          label: "Open GitHub",
          onClick: () => window.open(res.deleteAppUrl, "_blank", "noopener")
        }
      });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Disconnect failed");
    }
  });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitBranch className="h-4 w-4" />
            {app.name}
            {app.installed ? (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3 w-3" />
                installed
              </Badge>
            ) : (
              <Badge variant="warning">not installed</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {app.ownerLogin ? `Owned by ${app.ownerLogin}. ` : ""}
            App ID {app.appId}, connected {formatRelativeTime(app.createdAt)}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!app.installed ? (
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p>
                The app exists but is not installed on an account yet, so it
                cannot read any repositories. Install it to finish setup.
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={app.installed ? "outline" : "default"}
              onClick={() => {
                window.location.href = app.installUrl;
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {app.installed ? "Change repository access" : "Install app"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => window.open(app.htmlUrl, "_blank", "noopener")}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              App settings on GitHub
            </Button>
            <Button
              type="button"
              variant="outline"
              className="text-destructive"
              onClick={() => setConfirmDisconnect(true)}
            >
              <Unplug className="mr-2 h-4 w-4" />
              Disconnect
            </Button>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <span className="text-muted-foreground">Webhook URL</span>
            <span className="flex min-w-0 items-center gap-1">
              <code className="truncate text-xs">{status.webhookUrl}</code>
              <CopyButton text={status.webhookUrl} />
            </span>
          </div>
        </CardContent>
      </Card>

      {app.installed ? <RepositoryList /> : null}
      <DeliveryLog />

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect GitHub?"
        description="Push deploys stop immediately and auto-deploy is turned off for every app. Private repositories will fail to clone until you reconnect. This does not delete the app on GitHub."
        confirmLabel="Disconnect"
        variant="destructive"
        onConfirm={() => {
          disconnect.mutate();
        }}
      />
    </>
  );
}

export function GitPage() {
  const queryClient = useQueryClient();
  const statusQ = useQuery({
    queryKey: ["github", "app"],
    queryFn: () => apiGet<GitHubAppStatus>("/api/github/app")
  });

  useCallbackNotice(() => {
    void queryClient.invalidateQueries({ queryKey: ["github"] });
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Git"
        description="Connect a GitHub App so Sohwe can clone private repositories, deploy on push, and report build status back to the commit."
      />

      {statusQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : null}
      {statusQ.isError ? (
        <p className="text-sm text-destructive">
          Could not load GitHub settings.
        </p>
      ) : null}
      {statusQ.data ? (
        statusQ.data.connected && statusQ.data.app ? (
          <ConnectedCard status={statusQ.data} />
        ) : (
          <ConnectCard status={statusQ.data} />
        )
      ) : null}
    </div>
  );
}
