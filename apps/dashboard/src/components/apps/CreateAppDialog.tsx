import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CreateApplicationSchema, normalizeHostname, type ConfigField, type VariableEntry } from "@sohwe/types";
import { missingRequiredVariables } from "@sohwe/types/required-variables";
import { Lock, Search } from "lucide-react";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, apiGet } from "@/lib/api";
import type { AppRow, BuildMode, GitHubAppStatus, GitHubRepo, RepositoryInspection } from "@/lib/types";
import { InitialVariablesEditor, type InitialVariablesEditorHandle } from "./InitialVariablesEditor";

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

function githubRepoNameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" || !["github.com", "www.github.com"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return undefined;
    return `${parts[0]}/${parts[1]!.replace(/\.git$/i, "")}`.toLowerCase();
  } catch {
    return undefined;
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
  const variablesEditor = useRef<InitialVariablesEditorHandle>(null);
  const [cName, setCName] = useState("");
  const [cSlug, setCSlug] = useState("");
  const [cRepo, setCRepo] = useState("");
  const [cBranch, setCBranch] = useState("main");
  const [cPort, setCPort] = useState(3000);
  const [cBuildMode, setCBuildMode] = useState<BuildMode>("auto");
  const [cBuildCmd, setCBuildCmd] = useState("");
  const [cStartCmd, setCStartCmd] = useState("");
  const [cRuntimeCmd, setCRuntimeCmd] = useState("");
  const [cAppDirectory, setCAppDirectory] = useState(".");
  const [cDockerfilePath, setCDockerfilePath] = useState("Dockerfile");
  const [cDockerTarget, setCDockerTarget] = useState("");
  const [cDomain, setCDomain] = useState("");
  const [cAutoDeploy, setCAutoDeploy] = useState(false);
  const [cVariables, setCVariables] = useState<VariableEntry[]>([]);
  const [cConfigPath, setCConfigPath] = useState("");
  const [variableError, setVariableError] = useState<string | null>(null);
  const [repoSearch, setRepoSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<string | undefined>();
  const [nameEdited, setNameEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [branchEdited, setBranchEdited] = useState(false);
  const [manualBranch, setManualBranch] = useState(false);
  const [branchLookupRequested, setBranchLookupRequested] = useState(false);
  const [repoTouched, setRepoTouched] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  // A taken slug is a field problem, not a request problem — show it on the
  // field instead of in a toast that disappears before the fix is typed.
  const [slugError, setSlugError] = useState<string | null>(null);
  const [savedApp, setSavedApp] = useState<AppRow | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [inspectionRequested, setInspectionRequested] = useState(false);
  const [editedPlanFields, setEditedPlanFields] = useState<Set<string>>(() => new Set());

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
  const githubRepoName = githubRepoNameFromUrl(cRepo);
  const pushRepo = reposQ.data?.repositories.find((repo) => repo.fullName.toLowerCase() === githubRepoName);
  const canEnablePushDeploy = githubInstalled && reposQ.isSuccess && !!pushRepo;
  const branchesQ = useQuery({
    queryKey: ["repository-branches", cRepo.trim()],
    queryFn: () => api<{ branches: string[]; defaultBranch: string | null; truncated: boolean }>("/api/repositories/branches", {
      method: "POST",
      body: JSON.stringify({ gitRepo: cRepo.trim() })
    }),
    enabled: open && branchLookupRequested && !repository.error && !savedApp,
    retry: false,
    staleTime: 60_000
  });
  const effectiveBranch = branchEdited ? cBranch : branchesQ.data?.defaultBranch ?? cBranch;
  const branchChoices = branchesQ.data?.branches ?? [];
  const branchReady = branchesQ.isSuccess || branchesQ.isError;
  const showManualBranch = manualBranch || branchesQ.isError || branchesQ.isSuccess && !branchChoices.includes(effectiveBranch);
  const inspectionDirectory = editedPlanFields.has("appDirectory") ? cAppDirectory : undefined;
  const inspectionQ = useQuery({
    queryKey: ["repository-inspection", cRepo.trim(), effectiveBranch.trim(), inspectionDirectory, cConfigPath.trim()],
    queryFn: () => api<RepositoryInspection>("/api/repositories/inspect", {
      method: "POST",
      body: JSON.stringify({ gitRepo: cRepo.trim(), branch: effectiveBranch.trim(), directory: inspectionDirectory, configPath: cConfigPath.trim() || undefined })
    }),
    enabled: open && branchReady && inspectionRequested && !repository.error && !!effectiveBranch.trim() && !savedApp,
    retry: false,
    staleTime: 60_000
  });
  const inspection = inspectionQ.data;
  const basePlan = inspection?.resolved.values;
  const effectiveName = nameEdited ? cName : inspection?.config?.application.name ?? cName;
  const effectiveDirectory = editedPlanFields.has("appDirectory") ? cAppDirectory : basePlan?.appDirectory ?? cAppDirectory;
  const selectedCandidate = inspection?.candidates.find((candidate) => candidate.directory === effectiveDirectory) ?? inspection?.selected;
  const effectiveMode = editedPlanFields.has("buildMode") ? cBuildMode : basePlan?.buildMode ?? cBuildMode;
  const effectiveDockerfile = editedPlanFields.has("dockerfilePath") ? cDockerfilePath : basePlan?.dockerfilePath ?? cDockerfilePath;
  const effectiveDockerTarget = editedPlanFields.has("dockerTarget") ? cDockerTarget : basePlan?.dockerTarget ?? cDockerTarget;
  const effectiveBuildCmd = editedPlanFields.has("buildCmd") ? cBuildCmd : basePlan?.buildCmd ?? cBuildCmd;
  const effectiveStartCmd = editedPlanFields.has("startCmd") ? cStartCmd : basePlan?.startCmd ?? cStartCmd;
  const effectiveRuntimeCmd = editedPlanFields.has("runtimeCmd") ? cRuntimeCmd : basePlan?.runtimeCmd ?? cRuntimeCmd;
  const effectivePort = editedPlanFields.has("port") ? cPort : basePlan?.port ?? cPort;
  const requiredVariables = inspection?.config?.application.variables?.filter((item) => item.required) ?? [];
  const displayedVariables = [...cVariables];
  for (const required of requiredVariables) if (!displayedVariables.some((entry) => entry.key === required.key)) displayedVariables.push({ key: required.key, value: "", scope: required.scope });
  const planSource = (field: ConfigField) => editedPlanFields.has(field) ? "override" : inspection?.resolved.sources[field] ?? "default";

  useEffect(() => {
    if (!open || repository.error || !branchReady || !effectiveBranch.trim()) return;
    const timer = setTimeout(() => setInspectionRequested(true), 500);
    return () => clearTimeout(timer);
  }, [open, cRepo, effectiveBranch, inspectionDirectory, cConfigPath, branchReady, repository.error]);

  useEffect(() => {
    if (!open || repository.error) return;
    const timer = setTimeout(() => setBranchLookupRequested(true), 500);
    return () => clearTimeout(timer);
  }, [open, cRepo, repository.error]);

  function markEdited(field: string) {
    setEditedPlanFields((current) => new Set(current).add(field));
  }
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
    setCAutoDeploy(false);
    setInspectionRequested(false);
    setBranchLookupRequested(false);
    setManualBranch(false);
    setBranchEdited(false);
    setCAppDirectory(".");
    setEditedPlanFields(new Set());
    setCConfigPath("");
    setCVariables([]);
    const parsed = repositoryNameFromUrl(next);
    const name = suggestedName ?? parsed.name ?? "";
    if (!nameEdited) setCName(name);
    if (!slugEdited) {
      setCSlug(slugFromRepoName(name));
      setSlugError(null);
    }
    setCBranch(defaultBranch);
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
    setCAppDirectory(".");
    setCDockerfilePath("Dockerfile");
    setCDockerTarget("");
    setCDomain("");
    setCAutoDeploy(false);
    setCVariables([]);
    setCConfigPath("");
    setVariableError(null);
    setRepoSearch("");
    setSelectedRepo(undefined);
    setNameEdited(false);
    setSlugEdited(false);
    setBranchEdited(false);
    setManualBranch(false);
    setBranchLookupRequested(false);
    setRepoTouched(false);
    setSlugTouched(false);
    setSlugError(null);
    setSavedApp(null);
    setDeployError(null);
    setInspectionRequested(false);
    setEditedPlanFields(new Set());
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
    mutationFn: async ({ intent, variables }: { intent: "deploy" | "save"; variables: VariableEntry[] }) => {
      setSlugError(null);
      const body = CreateApplicationSchema.parse({
        name: effectiveName,
        slug: cSlug,
        gitRepo: cRepo.trim(),
        gitBranch: effectiveBranch,
        port: effectivePort,
        buildMode: effectiveMode,
        buildCmd: effectiveBuildCmd || undefined,
        startCmd: effectiveStartCmd || undefined,
        runtimeCmd: effectiveRuntimeCmd || undefined,
        appDirectory: effectiveDirectory,
        dockerfilePath: effectiveDockerfile,
        dockerTarget: effectiveDockerTarget || undefined,
        configPath: inspection?.configPath ?? undefined,
        configOverrides: inspection?.configPath ? [...editedPlanFields].filter((field): field is ConfigField => ["appDirectory", "buildMode", "dockerfilePath", "dockerTarget", "buildCmd", "startCmd", "runtimeCmd", "port"].includes(field)) : undefined,
        // Normalized the same way the Domains tab does, so a pasted URL works
        // here too rather than being rejected as a malformed hostname.
        domain: cDomain.trim() ? normalizeHostname(cDomain) : undefined,
        variables,
        autoDeploy: canEnablePushDeploy && cAutoDeploy
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
              if (repository.error || !cSlug || !/^[a-z0-9-]+$/.test(cSlug) || slugTaken || !branchReady || !inspectionRequested || !inspection || inspectionQ.isFetching) return;
              const initialVariables = variablesEditor.current?.collect() ?? { vars: cVariables };
              if ("error" in initialVariables) {
                setVariableError(initialVariables.error);
                return;
              }
              const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
              const intent = submitter?.value === "save" ? "save" : "deploy";
              if (intent === "deploy" && inspection.config) {
                const runtime = Object.fromEntries(initialVariables.vars.filter((entry) => entry.scope !== "build").map((entry) => [entry.key, entry.value]));
                const build = Object.fromEntries(initialVariables.vars.filter((entry) => entry.scope !== "runtime").map((entry) => [entry.key, entry.value]));
                const missing = missingRequiredVariables(inspection.config, runtime, build);
                if (missing.length) { setVariableError(`Set required variables before deploying: ${missing.join(", ")}`); return; }
              }
              setVariableError(null);
              createMut.mutate({
                intent,
                variables: initialVariables.vars
              });
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
                  value={effectiveName}
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
                {branchesQ.isSuccess && branchChoices.length > 0 ? (
                  <Select value={showManualBranch ? ":manual" : effectiveBranch} onValueChange={(value) => {
                    setInspectionRequested(false);
                    if (value === ":manual") {
                      setManualBranch(true);
                    } else {
                      setCBranch(value);
                      setBranchEdited(true);
                      setManualBranch(false);
                    }
                  }}>
                    <SelectTrigger><SelectValue placeholder="Choose a branch" /></SelectTrigger>
                    <SelectContent>
                      {branchChoices.map((branch) => <SelectItem key={branch} value={branch}>{branch}{branch === branchesQ.data.defaultBranch ? " (default)" : ""}</SelectItem>)}
                      <SelectItem value=":manual">Enter a branch manually…</SelectItem>
                    </SelectContent>
                  </Select>
                ) : branchesQ.isError || branchesQ.isSuccess ? null : (
                  <Select disabled><SelectTrigger><SelectValue placeholder="Loading branches…" /></SelectTrigger></Select>
                )}
                {showManualBranch || branchesQ.isSuccess && branchChoices.length === 0 ? (
                  <Input value={effectiveBranch} onChange={(e) => {
                    setCBranch(e.target.value);
                    setBranchEdited(true);
                    setInspectionRequested(false);
                  }} required placeholder="Branch name" />
                ) : null}
                {branchesQ.isError ? <span className="text-xs text-muted-foreground">Could not load branches. Enter a branch name to continue.</span> : null}
                {branchesQ.data?.truncated ? <span className="text-xs text-muted-foreground">Showing the first 100 branches. Enter another branch manually if needed.</span> : null}
              </Field>
              <Field label="Container port">
                <Input
                  type="number"
                  value={effectivePort}
                  onChange={(e) => { setCPort(Number(e.target.value)); markEdited("port"); }}
                  min={1}
                  max={65535}
                />
                <span className="text-xs text-muted-foreground">Confirm the port your process listens on; 3000 is the fallback.</span>
              </Field>
            </div>
            <Field label="Build mode">
              <Select value={effectiveMode} onValueChange={(v) => { setCBuildMode(v as BuildMode); markEdited("buildMode"); }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (Dockerfile, then Nixpacks)</SelectItem>
                  <SelectItem value="dockerfile">Dockerfile</SelectItem>
                  <SelectItem value="nixpacks">Nixpacks</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">Dockerfile builds always use the repository root as context. Nixpacks uses the root for workspaces.</span>
            </Field>
            <section className="rounded-xl border border-border bg-muted/20 p-4" aria-label="Repository inspection and build plan">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Build plan</h3>
                  <p className="text-xs text-muted-foreground">Review what Sohwe will build and run before creating the app.</p>
                </div>
                {inspectionQ.isFetching ? <span className="text-xs text-muted-foreground" role="status">Inspecting branch…</span> : null}
              </div>
              {inspectionQ.isError ? <p className="mt-2 text-xs text-destructive" role="alert">{inspectionQ.error instanceof Error ? inspectionQ.error.message : "Inspection failed."} <button type="button" className="underline" onClick={() => void inspectionQ.refetch()}>Retry</button></p> : null}
              {inspection && !inspectionQ.isFetching ? (
                <div className="mt-3 space-y-3 text-sm">
                  <p className="text-xs text-muted-foreground">{inspection.branch} at <code>{inspection.commitSha.slice(0, 12)}</code> · Docker and workspace context: repository root</p>
                  <p className="text-xs text-muted-foreground">{inspection.configPath ? `Configuration: ${inspection.configPath}` : "No sohwe.yaml found; using repository detection."}</p>
                  <Field label="App directory">
                    <Select value={effectiveDirectory} onValueChange={(value) => { setCAppDirectory(value); setInspectionRequested(false); markEdited("appDirectory"); }}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{inspection.candidates.map((item) => <SelectItem key={item.directory} value={item.directory}>{item.directory === "." ? "Repository root" : item.directory}</SelectItem>)}</SelectContent>
                    </Select>
                    <span className="text-xs text-muted-foreground">Choose another detected application, or enter a path in Advanced settings.</span>
                  </Field>
                  <div className="grid gap-2 rounded-lg border border-border/70 bg-background p-3 text-xs sm:grid-cols-2">
                    <span>Builder: <strong>{effectiveMode === "auto" ? `Auto (${selectedCandidate?.buildMode ?? "inspect on deploy"})` : effectiveMode}</strong> · {planSource("buildMode")}</span>
                    <span>App directory: <strong>{effectiveDirectory}</strong> · {planSource("appDirectory")}</span>
                    <span>Dockerfile: <strong>{effectiveMode === "nixpacks" ? "Not used" : effectiveDockerfile}</strong> · {planSource("dockerfilePath")}</span>
                    <span>Container port: <strong>{effectivePort}</strong> · {planSource("port")}</span>
                    <span>Docker target: <strong>{effectiveDockerTarget || "None"}</strong> · {planSource("dockerTarget")}</span>
                    <span className="sm:col-span-2">Start: <strong>{effectiveRuntimeCmd || (effectiveMode === "dockerfile" ? selectedCandidate?.startDisplay || "Image CMD / ENTRYPOINT (verify Dockerfile)" : effectiveStartCmd || "Nixpacks detection")}</strong> · {effectiveRuntimeCmd ? planSource("runtimeCmd") : planSource("startCmd")}</span>
                    {effectiveMode !== "dockerfile" ? <span className="sm:col-span-2">Build command: <strong>{effectiveBuildCmd || "Nixpacks detection"}</strong> · {planSource("buildCmd")}</span> : null}
                  </div>
                  {editedPlanFields.size ? <Button type="button" size="sm" variant="outline" onClick={() => setEditedPlanFields(new Set())}>Clear build-plan overrides</Button> : null}
                  <div>
                    <p className="text-xs font-medium">Evidence</p>
                    <ul className="mt-1 space-y-1 text-xs text-muted-foreground">{selectedCandidate?.evidence.map((item, index) => <li key={`${item.path}-${index}`}><code>{item.path}</code> — {item.detail}</li>)}</ul>
                  </div>
                </div>
              ) : null}
            </section>
            <InitialVariablesEditor
              ref={variablesEditor}
              value={displayedVariables}
              onChange={(entries) => {
                setCVariables(entries);
                setVariableError(null);
              }}
              disabled={pending}
            />
            {requiredVariables.length ? <p className="text-xs text-muted-foreground">Required by {inspection?.configPath}: {requiredVariables.map((item) => `${item.key} (${item.scope})${item.description ? ` — ${item.description}` : ""}`).join("; ")}. Enter values before creating.</p> : null}
            {variableError ? <p className="text-xs text-destructive" role="alert">{variableError}</p> : null}
            <details className="rounded-lg border border-border/70 bg-muted/20 p-3">
              <summary className="cursor-pointer text-sm font-medium">Advanced settings</summary>
              <div className="mt-3 space-y-3">
                <Field label="Repository config path (optional)">
                  <Input value={cConfigPath} onChange={(e) => { setCConfigPath(e.target.value); setInspectionRequested(false); }} placeholder="sohwe.yaml or apps/api/sohwe.yaml" />
                  <span className="text-xs text-muted-foreground">Leave blank to discover sohwe.yaml at the repository root. This path does not change Docker build context.</span>
                </Field>
                <Field label="App directory (repository relative)">
                  <Input value={effectiveDirectory} onChange={(e) => { setCAppDirectory(e.target.value); setInspectionRequested(false); markEdited("appDirectory"); }} placeholder=". or apps/api" />
                </Field>
                {effectiveMode !== "dockerfile" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Build command (optional)">
                      <Input
                        value={effectiveBuildCmd}
                        onChange={(e) => { setCBuildCmd(e.target.value); markEdited("buildCmd"); }}
                        placeholder="Nixpacks auto-detects"
                      />
                    </Field>
                    <Field label="Start command (optional)">
                      <Input
                        value={effectiveStartCmd}
                        onChange={(e) => { setCStartCmd(e.target.value); markEdited("startCmd"); }}
                        placeholder="Nixpacks auto-detects"
                      />
                    </Field>
                  </div>
                ) : null}
                {effectiveMode !== "nixpacks" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Dockerfile path">
                      <Input
                        value={effectiveDockerfile}
                        onChange={(e) => { setCDockerfilePath(e.target.value); markEdited("dockerfilePath"); }}
                        placeholder="Dockerfile or apps/api/Dockerfile"
                      />
                    </Field>
                    <Field label="Docker target (optional)">
                      <Input
                        value={effectiveDockerTarget}
                        onChange={(e) => { setCDockerTarget(e.target.value); markEdited("dockerTarget"); }}
                        placeholder="api, worker, migrate…"
                      />
                    </Field>
                  </div>
                ) : null}
                <Field label="Container command override (optional)">
                  <Input
                    value={effectiveRuntimeCmd}
                    onChange={(e) => { setCRuntimeCmd(e.target.value); markEdited("runtimeCmd"); }}
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
            <section className="rounded-lg border border-border/70 bg-muted/20 p-3" aria-label="Push to deploy">
              <h3 className="text-sm font-medium">Push to deploy</h3>
              {canEnablePushDeploy ? (
                <label className="mt-2 flex items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5 h-4 w-4 rounded border-border"
                    checked={cAutoDeploy}
                    onChange={(e) => setCAutoDeploy(e.target.checked)}
                  />
                  <span>
                    Deploy future pushes to <code className="text-xs">{effectiveBranch || "the tracked branch"}</code> from <code className="text-xs">{pushRepo.fullName}</code>.
                    <span className="block text-xs text-muted-foreground">
                      Off by default. Create and deploy starts the first deployment now; turn this on to deploy later pushes to this branch.
                    </span>
                  </span>
                </label>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {githubInstalled && reposQ.isPending
                    ? "Checking whether this repository is shared with your GitHub App…"
                    : githubInstalled && reposQ.isError
                      ? "Could not verify GitHub repository access. Push to deploy is unavailable until the repository list loads."
                      : !githubInstalled
                        ? "Connect a GitHub App to enable push deploys for shared repositories."
                        : githubRepoName
                          ? "Share this repository with the connected GitHub App to enable push deploys."
                          : "Push to deploy requires a GitHub repository shared with the connected App."}{" "}
                  <Link to="/git" className="underline underline-offset-2">Git settings</Link>
                </p>
              )}
            </section>
            <div className="flex justify-end gap-2">
              <Button type="submit" value="deploy" disabled={pending || !branchReady || !inspectionRequested || !inspection || inspectionQ.isFetching}>
                {createMut.isPending ? "Creating…" : "Create and deploy"}
              </Button>
              <Button type="submit" value="save" variant="outline" disabled={pending || !branchReady || !inspectionRequested || !inspection || inspectionQ.isFetching}>Save for later</Button>
              <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
