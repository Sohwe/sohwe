import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DomainSchema, normalizeHostname } from "@sohwe/types";
import { ExternalLink, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, apiGet, fetchMe } from "@/lib/api";
import { activeRelease, projectServiceHost, useProject } from "@/lib/projects";
import { useAppConfig } from "@/lib/config";
import { isAdmin } from "@/lib/roles";
import type { DnsInspection, Me, ProjectService } from "@/lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { CopyButton } from "@/components/common/CopyButton";

function DomainRow({
  hostname,
  primary,
  generated,
  admin,
  busy,
  onPrimary,
  onRemove,
}: {
  hostname: string;
  primary?: boolean;
  generated?: boolean;
  admin: boolean;
  busy: boolean;
  onPrimary?: () => void;
  onRemove?: () => void;
}) {
  const { httpsEnabled } = useAppConfig();
  const [check, setCheck] = useState(false);
  const inspection = useQuery({
    queryKey: ["dns-inspection", hostname],
    queryFn: () =>
      apiGet<DnsInspection>(
        `/api/dns/inspect?${new URLSearchParams({ domain: hostname })}`,
      ),
    enabled: check,
    staleTime: 30_000,
  });
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <a
            href={`${httpsEnabled ? "https" : "http"}://${hostname}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 break-all text-sm font-medium text-primary hover:underline"
          >
            {hostname}
            <ExternalLink className="size-3 shrink-0" />
          </a>
          <CopyButton text={hostname} label="Copy hostname" />
          <Badge variant="outline">
            {generated ? "Generated" : primary ? "Primary" : "Custom"}
          </Badge>
          {inspection.data ? (
            <Badge
              variant={
                inspection.data.status === "verified" ? "success" : "outline"
              }
            >
              {inspection.data.status}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={inspection.isFetching}
            onClick={() => {
              setCheck(true);
              if (check) void inspection.refetch();
            }}
          >
            <RefreshCw className="mr-1 size-3" />
            {inspection.isFetching ? "Checking…" : "Check DNS"}
          </Button>
          {admin && !generated ? (
            <>
              {!primary ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={onPrimary}
                >
                  Make primary
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={onRemove}
              >
                Remove
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {inspection.isError ? (
        <p role="alert" className="text-sm text-destructive">
          DNS inspection failed. Try checking again.
        </p>
      ) : null}
      {inspection.data ? (
        <div className="space-y-2 text-xs text-muted-foreground">
          {inspection.data.provider ? (
            <p>
              DNS hosted at {inspection.data.provider.name}
              {inspection.data.provider.url ? (
                <>
                  {" "}
                  ·{" "}
                  <a
                    className="text-primary underline"
                    href={inspection.data.provider.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open DNS console
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          {inspection.data.record ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted p-3">
              <span>Required record:</span>
              <strong>{inspection.data.record.type}</strong>
              <span className="break-all font-mono">
                {inspection.data.record.name}
              </span>
              <CopyButton
                text={inspection.data.record.name}
                label="Copy DNS record name"
              />
              <span>→</span>
              <span className="font-mono">{inspection.data.record.value}</span>
              <CopyButton
                text={inspection.data.record.value}
                label="Copy server IP"
              />
            </div>
          ) : null}
          {inspection.data.expectedIpIssue ? (
            <p>{inspection.data.expectedIpIssue}</p>
          ) : null}
          <p>
            Resolves to:{" "}
            {inspection.data.resolvedIps.join(", ") || "no addresses"}. DNS
            checks do not verify the HTTPS certificate or application health.
          </p>
        </div>
      ) : null}
    </div>
  );
}
function ServiceDomains({
  service,
  projectSlug,
  admin,
  releasing,
}: {
  service: ProjectService;
  projectSlug: string;
  admin: boolean;
  releasing: boolean;
}) {
  const client = useQueryClient();
  const { baseDomain } = useAppConfig();
  const [hostname, setHostname] = useState("");
  const [remove, setRemove] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (domains: string[]) =>
      api(`/api/services/${service.id}/domains`, {
        method: "PUT",
        body: JSON.stringify({ domains }),
      }),
    onSuccess: () => {
      setHostname("");
      void client.invalidateQueries({ queryKey: ["project"] });
      void client.invalidateQueries({ queryKey: ["projects"] });
      toast.success(
        "Domains saved. Release the project to apply routing changes.",
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const hosts = service.domains.map((domain) => domain.hostname);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {service.name}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            · port {service.port}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <DomainRow
          hostname={projectServiceHost(projectSlug, service.slug, baseDomain)}
          generated
          admin={admin}
          busy={false}
        />
        {service.domains.map((domain) => (
          <DomainRow
            key={domain.hostname}
            hostname={domain.hostname}
            primary={domain.isPrimary}
            admin={admin}
            busy={mutation.isPending || releasing}
            onPrimary={() =>
              mutation.mutate([
                domain.hostname,
                ...hosts.filter((host) => host !== domain.hostname),
              ])
            }
            onRemove={() => setRemove(domain.hostname)}
          />
        ))}
        {admin ? (
          <form
            className="flex flex-wrap gap-2 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = DomainSchema.safeParse(
                normalizeHostname(hostname),
              );
              if (!parsed.success) {
                toast.error(
                  "Enter a valid hostname, such as gifts.example.com.",
                );
                return;
              }
              const generated = projectServiceHost(
                projectSlug,
                service.slug,
                baseDomain,
              );
              if (hosts.includes(parsed.data) || parsed.data === generated) {
                toast.error("This hostname is already configured.");
                return;
              }
              mutation.mutate([...hosts, parsed.data]);
            }}
          >
            <Input
              className="min-w-48 flex-1"
              aria-label={`New domain for ${service.name}`}
              required
              placeholder="gifts.example.com"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
            />
            <Button type="submit" disabled={releasing || mutation.isPending}>
              Add domain
            </Button>
          </form>
        ) : null}
        <ConfirmDialog
          open={remove !== null}
          onOpenChange={(open) => !open && setRemove(null)}
          title="Remove custom domain"
          description={`${remove ?? "This hostname"} will stop routing to this service on the next project release.`}
          confirmLabel="Remove domain"
          variant="destructive"
          onConfirm={() =>
            mutation.mutate(hosts.filter((host) => host !== remove))
          }
        />
      </CardContent>
    </Card>
  );
}
export function ProjectDomainsPage() {
  const { data: project } = useProject();
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => fetchMe<Me | null>(),
  });
  if (!project) return null;
  const services = project.services.filter(
    (service) => service.kind === "http",
  );
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Domains</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage hostnames for each public HTTP service. Point DNS at this
          server before releasing to allow certificate issuance. Saved changes
          apply on the next release.
        </p>
      </div>
      {services.length ? (
        services.map((service) => (
          <ServiceDomains
            key={service.id}
            service={service}
            projectSlug={project.slug}
            admin={isAdmin(me)}
            releasing={project.releases.some((release) =>
              activeRelease(release.status),
            )}
          />
        ))
      ) : (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground">
          This project has no HTTP services. Add one in Settings to configure
          domains.
        </p>
      )}
    </div>
  );
}
