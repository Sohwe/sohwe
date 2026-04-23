import { useMemo } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { deploymentResultLabel, formatDuration, formatRelativeTime, shortCommitSha, shortDepId, truncMsg } from "@/lib/format";
import type { AppRow } from "@/lib/types";
import { getCurrentDeploymentId } from "@/lib/types";

export function DeploymentsTable({
  app,
  onViewLog,
  onRollBack,
  actionsDisabled
}: {
  app: AppRow;
  onViewLog: (deploymentId: string) => void;
  onRollBack: (sourceDeploymentId: string) => void;
  actionsDisabled: boolean;
}) {
  const currentId = getCurrentDeploymentId(app.deployments);
  const rows = useMemo(
    () =>
      [...(app.deployments ?? [])].sort(
        (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)
      ),
    [app.deployments]
  );
  if (!rows.length) {
    return <p className="text-sm text-muted-foreground">No deployments yet. Click Deploy to create one.</p>;
  }
  return (
    <div className="w-full">
      <div className="hidden min-[640px]:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Deployment</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Git</TableHead>
              <TableHead>When</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => {
              const res = deploymentResultLabel(d.status);
              const isCurrent = currentId != null && d.id === currentId;
              const canRollBackTo =
                d.status === "success" && Boolean(d.imageTag) && !isCurrent;
              return (
                <TableRow key={d.id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm font-medium">{shortDepId(d.id)}</span>
                      {isCurrent ? <Badge>Current</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm">{res.text}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {formatDuration(d.startedAt, d.finishedAt)}
                    </p>
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-xs">{app.gitBranch}</div>
                    <div className="mt-0.5 break-all text-xs text-muted-foreground">
                      {shortCommitSha(d.commitSha)}{" "}
                      {d.commitMessage ? (
                        <span className="text-foreground/80">{truncMsg(d.commitMessage, 64)}</span>
                      ) : d.commitSha ? null : (
                        "—"
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatRelativeTime(d.createdAt)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" disabled={actionsDisabled} aria-label="Open menu">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onViewLog(d.id)}>View build log</DropdownMenuItem>
                          {canRollBackTo ? (
                            <DropdownMenuItem onClick={() => onRollBack(d.id)}>Roll back to this</DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ul className="min-[640px]:hidden space-y-3">
        {rows.map((d) => {
          const res = deploymentResultLabel(d.status);
          const isCurrent = currentId != null && d.id === currentId;
          const canRollBackTo = d.status === "success" && Boolean(d.imageTag) && !isCurrent;
          return (
            <li
              key={d.id}
              className="rounded-lg border border-border bg-card/50 p-3 text-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-mono text-xs">
                    {shortDepId(d.id)} {isCurrent ? <Badge className="ml-1">Current</Badge> : null}
                  </p>
                  <p className={`mt-1 text-xs font-medium ${res.className}`}>{res.text}</p>
                </div>
                <Button size="sm" variant="secondary" disabled={actionsDisabled} onClick={() => onViewLog(d.id)}>
                  Log
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatRelativeTime(d.createdAt)} · {formatDuration(d.startedAt, d.finishedAt)}
              </p>
              {canRollBackTo ? (
                <Button
                  className="mt-2 w-full"
                  size="sm"
                  variant="outline"
                  disabled={actionsDisabled}
                  onClick={() => onRollBack(d.id)}
                >
                  Roll back
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
