import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CreateApplicationSchema, normalizeHostname } from "@sohwe/types";
import { Lock, Search } from "lucide-react";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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

function repositoryNameFromUrl(value: string): { name: string; error: null } | { name: null; error: string } {
  if (!value.trim()) return { name: null, error: "Enter an HTTPS Git repository URL." };
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") {
      return { name: null, error: "Use an HTTPS Git repository URL." };
    }
    if (url.username || url.password || url.search || url.hash) {
      return { name: null, error: "Use the repository URL without credentials, query, or fragment." };
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 1 || (url.hostname === "github.com" && parts.length !== 2) || parts.includes("-")) {
      return { name: null, error: "Paste a repository URL, for example https://github.com/org/repo." };
    }
    const name = decodeURIComponent(parts[parts.length - 1]!).replace(/\.git$/i, "");
    if (!name || name === "." || name === "..") {
      return { name: null, error: "The repository URL needs a repository name." };
    }
    return { name, error: null };
  } catch {
    return { name: null, error: "Enter a valid HTTPS Git repository URL." };
  }
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
  const navigate = useNavigate();
  const [cName, setCName] = useState("");
  const [cSlug, setCSlug] = useState("");
  const [cRepo, setCRepo] = useState("");
  const [cBranch, setCBranch] = useState("main");
  const [cPort, setCPort] = useState(3000);
  const [cBuildMode, setCBuildMode] = useState<BuildMode>("auto");
  const [cBuildCmd, setCBuildCmd] = useState("");
  const [cStartCmd, setCStartCmd] = useState("");
  const [cRuntimeCmd, setCRuntimeCmd] = useState("");
  const [cDockerfilePath, setCDockerfilePath] = useState("Dockerfile");
  const [cDockerTarget, setCDockerTarget] = useState("");
  const [cDomain, setCDomain] = useState("");
  const [cAutoDeploy, setCAutoDeploy] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<string | undefined>();
  const [nameEdited, setNameEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [branchEdited, setBranchEdited] = useState(false);
  const [repoTouched, setRepoTouched] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  // A taken slug is a field problem, not a request problem — show it on the
  // field instead of in a toast that disappears before the fix is typed.
  const [slugError, setSlugError] = useState<string | null>(null);
  const [savedApp, setSavedApp] = useState<AppRow | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);

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

  const appsQ = useQuery({
    queryKey: ["applications"],
    queryFn: () => api<AppRow[]>("/api/applications"),
    enabled: open && !savedApp
  });
  const repository = repositoryNameFromUrl(cRepo);
  const repoError = repoTouched ? repository.error : null;
  const slugTaken = appsQ.data?.some((app) => app.slug === cSlug) ?? false;
  const currentSlugError = slugTaken
    ? "This slug is already used by another application."
    : slugError ?? (slugTouched && !cSlug
      ? "Enter a slug for the app URL."
      : slugTouched && !/^[a-z0-9-]+$/.test(cSlug)
        ? "Use lowercase letters, numbers, and hyphens only."
        : null);

  function changeSlug(next: string) {
    setCSlug(next.toLowerCase());
    setSlugEdited(true);
    setSlugTouched(true);
    setSlugError(null);
  }

  function changeRepo(next: string, suggestedName?: string, defaultBranch = "main") {
    setCRepo(next);
    const parsed = repositoryNameFromUrl(next);
    const name = suggestedName ?? parsed.name ?? "";
    if (!nameEdited) setCName(name);
    if (!slugEdited) {
      setCSlug(slugFromRepoName(name));
      setSlugError(null);
    }
    if (!branchEdited) setCBranch(defaultBranch);
  }

  function pickRepo(fullName: string) {
    const repo = reposQ.data?.repositories.find((r) => r.fullName === fullName);
    if (!repo) return;
    setSelectedRepo(fullName);
    changeRepo(repo.cloneUrl, repo.name, repo.defaultBranch);
    setRepoTouched(false);
  }

  function resetForm() {
    setCName("");
    setCSlug("");
    setCRepo("");
    setCBranch("main");
    setCPort(3000);
    setCBuildMode("auto");
    setCBuildCmd("");
    setCStartCmd("");
    setCRuntimeCmd("");
    setCDockerfilePath("Dockerfile");
    setCDockerTarget("");
    setCDomain("");
    setCAutoDeploy(false);
    setRepoSearch("");
    setSelectedRepo(undefined);
    setNameEdited(false);
    setSlugEdited(false);
    setBranchEdited(false);
    setRepoTouched(false);
    setSlugTouched(false);
    setSlugError(null);
    setSavedApp(null);
    setDeployError(null);
  }

  const deployMut = useMutation({
    mutationFn: (app: AppRow) =>
      api<{ deployment: { id: string } }>(`/api/applications/${app.id}/deploy`, {
        method: "POST"
      }),
    onSuccess: (data, app) => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      resetForm();
      onOpenChange(false);
      toast.success("Deploy started");
      void navigate({
        to: "/apps/$appId/deployments/$deploymentId",
        params: { appId: app.id, deploymentId: data.deployment.id }
      });
    },
    onError: (error) => {
      setDeployError(error instanceof Error ? error.message : "Deploy request failed");
    }
  });

  const createMut = useMutation({
    mutationFn: async (intent: "deploy" | "save") => {
      setSlugError(null);
      const body = CreateApplicationSchema.parse({
        name: cName,
        slug: cSlug,
        gitRepo: cRepo.trim(),
        gitBranch: cBranch,
        port: cPort,
        buildMode: cBuildMode,
        buildCmd: cBuildCmd || undefined,
        startCmd: cStartCmd || undefined,
        runtimeCmd: cRuntimeCmd || undefined,
        dockerfilePath: cDockerfilePath,
        dockerTarget: cDockerTarget || undefined,
        // Normalized the same way the Domains tab does, so a pasted URL works
        // here too rather than being rejected as a malformed hostname.
        domain: cDomain.trim() ? normalizeHostname(cDomain) : undefined,
        autoDeploy: cAutoDeploy
      });
      const app = await api<AppRow>("/api/applications", { method: "POST", body: JSON.stringify(body) });
      return { app, intent };
    },
    onSuccess: ({ app, intent }) => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      setSavedApp(app);
      onCreated?.(app);
      if (intent === "save") {
        resetForm();
        onOpenChange(false);
        toast.success("Application saved for later");
      } else {
        deployMut.mutate(app);
      }
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

  const pending = createMut.isPending || deployMut.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next && pending) return;
      onOpenChange(next);
    }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New application</DialogTitle>
          <DialogDescription>Choose a Git repository, then deploy now or save the app for later.</DialogDescription>
        </DialogHeader>
        {savedApp ? (
          <div className="mt-2 space-y-4">
            <p className="text-sm">
              <strong>{savedApp.name}</strong> was saved. The app will not be created again when you retry.
            </p>
            {deployMut.isPending ? (
              <p className="text-sm text-muted-foreground" role="status">Starting the first deployment…</p>
            ) : null}
            {deployError ? (
              <p className="text-sm text-destructive" role="alert">
                The deploy request failed: {deployError}. Your app is saved; retry the deployment from here.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {deployError ? (
                <Button type="button" disabled={pending} onClick={() => {
                  setDeployError(null);
                  deployMut.mutate(savedApp);
                }}>
                  Retry deploy
                </Button>
              ) : null}
              <Button type="button" variant="outline" disabled={pending} onClick={() => {
                onOpenChange(false);
                void navigate({ to: "/apps/$appId/overview", params: { appId: savedApp.id } });
              }}>
                Open saved app
              </Button>
              {deployError ? (
                <Button type="button" variant="ghost" onClick={resetForm}>Create another app</Button>
              ) : null}
            </div>
          </div>
        ) : (
          <form
            className="mt-2 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setRepoTouched(true);
              setSlugTouched(true);
              if (repository.error || !cSlug || !/^[a-z0-9-]+$/.test(cSlug) || slugTaken) return;
              const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
              createMut.mutate(submitter?.value === "save" ? "save" : "deploy");
            }}
          >
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
                    <Select value={selectedRepo} onValueChange={pickRepo} disabled={filteredRepos.length === 0}>
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
                onChange={(e) => {
                  setSelectedRepo(undefined);
                  changeRepo(e.target.value);
                }}
                onBlur={() => {
                  setCRepo(cRepo.trim());
                  setRepoTouched(true);
                }}
                onInvalid={() => setRepoTouched(true)}
                required
                type="url"
                placeholder="https://github.com/org/repo"
                aria-invalid={repoError ? true : undefined}
                aria-describedby={repoError ? "new-app-repo-error" : undefined}
                className={repoError ? "border-destructive focus-visible:ring-destructive" : undefined}
              />
              {repoError ? <span id="new-app-repo-error" className="text-xs text-destructive" role="alert">{repoError}</span> : null}
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <Input
                  value={cName}
                  onChange={(e) => {
                    setCName(e.target.value);
                    setNameEdited(true);
                  }}
                  required
                />
              </Field>
              <Field label="Slug (subdomain)">
                <Input
                  value={cSlug}
                  onChange={(e) => changeSlug(e.target.value)}
                  onBlur={() => setSlugTouched(true)}
                  onInvalid={() => setSlugTouched(true)}
                  required
                  pattern="[a-z0-9-]+"
                  aria-invalid={currentSlugError ? true : undefined}
                  aria-describedby={currentSlugError ? "new-app-slug-error" : undefined}
                  className={currentSlugError ? "border-destructive focus-visible:ring-destructive" : undefined}
                />
                {currentSlugError ? <span id="new-app-slug-error" className="text-xs text-destructive" role="alert">{currentSlugError}</span> : null}
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Branch">
                <Input value={cBranch} onChange={(e) => {
                  setCBranch(e.target.value);
                  setBranchEdited(true);
                }} required />
                <span className="text-xs text-muted-foreground">Default: main, or the selected repository's default branch.</span>
              </Field>
              <Field label="Container port">
                <Input
                  type="number"
                  value={cPort}
                  onChange={(e) => setCPort(Number(e.target.value))}
                  min={1}
                  max={65535}
                />
                <span className="text-xs text-muted-foreground">Default: 3000. Use the port your app listens on.</span>
              </Field>
            </div>
            <Field label="Build mode">
              <Select value={cBuildMode} onValueChange={(v) => setCBuildMode(v as BuildMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (Dockerfile, then Nixpacks)</SelectItem>
                  <SelectItem value="dockerfile">Dockerfile</SelectItem>
                  <SelectItem value="nixpacks">Nixpacks</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">Auto uses a root Dockerfile when present, otherwise Nixpacks.</span>
            </Field>
            <details className="rounded-lg border border-border/70 bg-muted/20 p-3">
              <summary className="cursor-pointer text-sm font-medium">Advanced settings</summary>
              <div className="mt-3 space-y-3">
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
                {cBuildMode !== "nixpacks" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Dockerfile path">
                      <Input
                        value={cDockerfilePath}
                        onChange={(e) => setCDockerfilePath(e.target.value)}
                        placeholder="Dockerfile or apps/api/Dockerfile"
                      />
                    </Field>
                    <Field label="Docker target (optional)">
                      <Input
                        value={cDockerTarget}
                        onChange={(e) => setCDockerTarget(e.target.value)}
                        placeholder="api, worker, migrate…"
                      />
                    </Field>
                  </div>
                ) : null}
                <Field label="Container command override (optional)">
                  <Input
                    value={cRuntimeCmd}
                    onChange={(e) => setCRuntimeCmd(e.target.value)}
                    placeholder="node dist/worker.js"
                  />
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
            </details>
            {githubInstalled ? (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
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
              <Button type="submit" value="deploy" disabled={pending}>
                {createMut.isPending ? "Creating…" : "Create and deploy"}
              </Button>
              <Button type="submit" value="save" variant="outline" disabled={pending}>Save for later</Button>
              <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
