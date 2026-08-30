import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreateApplicationSchema, normalizeHostname } from "@sohwe/types";
import { Lock, Search } from "lucide-react";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, apiGet } from "@/lib/api";
import type { AppRow, BuildMode, GitHubAppStatus, GitHubRepo } from "@/lib/types";

/** `my-cool-repo` -> a slug that satisfies the API's `[a-z0-9-]+` rule. */
function slugFromRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CreateAppDialog({
  open,
  onOpenChange,
  onCreated
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated?: (app: AppRow) => void;
}) {
  const queryClient = useQueryClient();
  const [cName, setCName] = useState("");
  const [cSlug, setCSlug] = useState("");
  const [cRepo, setCRepo] = useState("");
  const [cBranch, setCBranch] = useState("main");
  const [cPort, setCPort] = useState(3000);
  const [cBuildMode, setCBuildMode] = useState<BuildMode>("auto");
  const [cBuildCmd, setCBuildCmd] = useState("");
  const [cStartCmd, setCStartCmd] = useState("");
  const [cDomain, setCDomain] = useState("");
  const [cAutoDeploy, setCAutoDeploy] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");
  // A taken slug is a field problem, not a request problem — show it on the
  // field instead of in a toast that disappears before the fix is typed.
  const [slugError, setSlugError] = useState<string | null>(null);

  const githubQ = useQuery({
    queryKey: ["github", "app"],
    queryFn: () => apiGet<GitHubAppStatus>("/api/github/app"),
    staleTime: 60_000
  });
  const githubInstalled = githubQ.data?.app?.installed === true;

  const reposQ = useQuery({
    queryKey: ["github", "repositories"],
    queryFn: () => apiGet<{ repositories: GitHubRepo[] }>("/api/github/repositories"),
    enabled: githubInstalled,
    staleTime: 60_000
  });
  const filteredRepos = useMemo(() => {
    const repositories = reposQ.data?.repositories ?? [];
    const query = repoSearch.trim().toLowerCase();
    if (!query) return repositories;
    return repositories.filter((repo) =>
      `${repo.fullName} ${repo.accountLogin ?? ""}`.toLowerCase().includes(query)
    );
  }, [repoSearch, reposQ.data?.repositories]);

  function changeSlug(next: string) {
    setCSlug(next.toLowerCase());
    setSlugError(null);
  }

  function pickRepo(fullName: string) {
    const repo = reposQ.data?.repositories.find((r) => r.fullName === fullName);
    if (!repo) return;
    setCRepo(repo.cloneUrl);
    setCBranch(repo.defaultBranch);
    // Only prefill identifiers the user hasn't already typed.
    if (!cName) setCName(repo.name);
    if (!cSlug) changeSlug(slugFromRepoName(repo.name));
  }

  const createMut = useMutation({
    mutationFn: () => {
      setSlugError(null);
      const body = CreateApplicationSchema.parse({
        name: cName,
        slug: cSlug,
        gitRepo: cRepo,
        gitBranch: cBranch,
        port: cPort,
        buildMode: cBuildMode,
        buildCmd: cBuildCmd || undefined,
        startCmd: cStartCmd || undefined,
        // Normalized the same way the Domains tab does, so a pasted URL works
        // here too rather than being rejected as a malformed hostname.
        domain: cDomain.trim() ? normalizeHostname(cDomain) : undefined,
        autoDeploy: cAutoDeploy
      });
      return api<AppRow>("/api/applications", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (app) => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      setCName("");
      setCSlug("");
      setCRepo("");
      setCBranch("main");
      setCPort(3000);
      setCBuildMode("auto");
      setCBuildCmd("");
      setCStartCmd("");
      setCDomain("");
      setCAutoDeploy(false);
      setRepoSearch("");
      setSlugError(null);
      onOpenChange(false);
      onCreated?.(app);
      toast.success("Application created");
    },
    onError: (e) => {
      const message = e instanceof Error ? e.message : "Create failed";
      if (/slug/i.test(message)) {
        setSlugError(message);
        return;
      }
      toast.error(message);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New application</DialogTitle>
          <DialogDescription>Public Git URL — Dockerfile or Nixpacks. Deploys to your instance.</DialogDescription>
        </DialogHeader>
        <form
          className="mt-2 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            createMut.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={cName} onChange={(e) => setCName(e.target.value)} required />
            </Field>
            <Field label="Slug (subdomain)">
              <Input
                value={cSlug}
                onChange={(e) => changeSlug(e.target.value)}
                required
                pattern="[a-z0-9-]+"
                aria-invalid={slugError ? true : undefined}
                className={slugError ? "border-destructive focus-visible:ring-destructive" : undefined}
              />
              {slugError ? <span className="text-xs text-destructive">{slugError}</span> : null}
            </Field>
          </div>
          {githubInstalled ? (
            <Field label="Repository (from connected GitHub installations)">
              {reposQ.isLoading ? (
                <p className="text-xs text-muted-foreground">Loading repositories…</p>
              ) : null}
              {reposQ.isError ? (
                <p className="text-xs text-destructive">
                  {reposQ.error instanceof Error
                    ? reposQ.error.message
                    : "Could not load GitHub repositories."}
                </p>
              ) : null}
              {reposQ.data && reposQ.data.repositories.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No repositories are shared with the connected installations yet.
                </p>
              ) : null}
              {reposQ.data && reposQ.data.repositories.length > 0 ? (
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={repoSearch}
                      onChange={(e) => setRepoSearch(e.target.value)}
                      className="pl-9"
                      placeholder="Search by repository or organization"
                      autoComplete="off"
                    />
                  </div>
                  <Select onValueChange={pickRepo} disabled={filteredRepos.length === 0}>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          filteredRepos.length === 0
                            ? "No matching repositories"
                            : `Pick a repository (${String(filteredRepos.length)} available)`
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredRepos.map((r) => (
                        <SelectItem key={`${String(r.installationId)}:${String(r.id)}`} value={r.fullName}>
                          <span className="flex items-center gap-1.5">
                            {r.fullName}
                            {r.private ? <Lock className="h-3 w-3 opacity-60" /> : null}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </Field>
          ) : null}
          <Field label={githubInstalled ? "Git URL (https)" : "Public Git URL (https)"}>
            <Input
              value={cRepo}
              onChange={(e) => setCRepo(e.target.value)}
              required
              type="url"
              placeholder="https://github.com/org/repo"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Branch">
              <Input value={cBranch} onChange={(e) => setCBranch(e.target.value)} required />
            </Field>
            <Field label="Container port">
              <Input
                type="number"
                value={cPort}
                onChange={(e) => setCPort(Number(e.target.value))}
                min={1}
                max={65535}
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Build mode">
              <Select value={cBuildMode} onValueChange={(v) => setCBuildMode(v as BuildMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto (Dockerfile → Nixpacks)</SelectItem>
                  <SelectItem value="dockerfile">dockerfile</SelectItem>
                  <SelectItem value="nixpacks">nixpacks</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Custom domain (optional)">
              <Input
                value={cDomain}
                onChange={(e) => setCDomain(e.target.value)}
                placeholder="app.example.com"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
          {cBuildMode !== "dockerfile" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Build command (optional)">
                <Input
                  value={cBuildCmd}
                  onChange={(e) => setCBuildCmd(e.target.value)}
                  placeholder="Nixpacks auto-detects"
                />
              </Field>
              <Field label="Start command (optional)">
                <Input
                  value={cStartCmd}
                  onChange={(e) => setCStartCmd(e.target.value)}
                  placeholder="Nixpacks auto-detects"
                />
              </Field>
            </div>
          ) : null}
          {githubInstalled ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-border"
                checked={cAutoDeploy}
                onChange={(e) => setCAutoDeploy(e.target.checked)}
              />
              <span>
                Deploy automatically on every push to{" "}
                <code className="text-xs">{cBranch || "the tracked branch"}</code>
                <span className="block text-xs text-muted-foreground">
                  Requires the repository to be shared with your GitHub App.
                </span>
              </span>
            </label>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending ? "Creating…" : "Create application"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
