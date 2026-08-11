import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitBranch } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";

/**
 * Push-to-deploy toggle. Saved immediately rather than folded into the main
 * settings form: the API refuses the change when no GitHub App is installed,
 * and that reason is worth showing on its own instead of failing a bulk save.
 */
export function AutoDeployCard({ app }: { app: AppRow }) {
  const queryClient = useQueryClient();

  const toggle = useMutation({
    mutationFn: (autoDeploy: boolean) =>
      api<AppRow>(`/api/applications/${app.id}`, {
        method: "PATCH",
        body: JSON.stringify({ autoDeploy })
      }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      toast.success(
        updated.autoDeploy
          ? `Auto-deploy on for ${app.gitBranch}`
          : "Auto-deploy off"
      );
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Could not change auto-deploy");
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitBranch className="h-4 w-4" />
          Push to deploy
        </CardTitle>
        <CardDescription>
          {app.repoFullName ? (
            <>
              Deploy automatically when <code>{app.repoFullName}</code> receives a
              push to <code>{app.gitBranch}</code>.
            </>
          ) : (
            "This app's repository is not a GitHub remote, so it cannot receive push webhooks."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border"
            checked={app.autoDeploy}
            disabled={!app.repoFullName || toggle.isPending}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
          <span>Deploy on push to {app.gitBranch}</span>
        </label>

        {app.repoFullName && !app.autoDeploy ? (
          <Button asChild type="button" variant="ghost" size="sm">
            <Link to="/git">GitHub settings</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
