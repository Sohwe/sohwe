import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  useState as useReactState
} from "react";
import { CreateApplicationSchema } from "@sohwe/types";
import { api, apiGet, fetchMe } from "./lib/api";

// --- setup / auth UI (Field, TextInput, Shell) unchanged in spirit ---

type SetupStatus = { needsSetup: boolean };

type Me = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  organization: { id: string; name: string };
};

type AppRow = {
  id: string;
  name: string;
  slug: string;
  gitRepo: string;
  gitBranch: string;
  port: number;
  status: string;
  buildMode: string;
  domain: string | null;
  createdAt: string;
  deployments?: {
    id: string;
    status: string;
    imageTag: string | null;
    commitSha: string | null;
    commitMessage: string | null;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }[];
};

/** Newest successful deployment (likely what’s running) — for “Current” badge. */
function getCurrentDeploymentId(
  deployments: AppRow["deployments"] | undefined
): string | null {
  if (!deployments?.length) return null;
  const sorted = [...deployments].sort(
    (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)
  );
  for (const d of sorted) {
    if (d.status === "success" && d.imageTag) return d.id;
  }
  return null;
}

function shortDepId(id: string): string {
  return id.replace(/-/g, "").slice(0, 9);
}

function shortCommitSha(sha: string | null | undefined): string {
  if (!sha) return "—";
  return sha.slice(0, 7);
}

function formatDuration(
  start: string | null | undefined,
  end: string | null | undefined
): string {
  if (!start || !end) return "—";
  const ms = +new Date(end) - +new Date(start);
  if (ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

function formatRelativeTime(iso: string): string {
  const t = +new Date(iso);
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function truncMsg(s: string | null | undefined, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function deploymentResultLabel(
  status: string
): { text: string; className: string } {
  if (status === "success")
    return { text: "Ready", className: "text-emerald-400" };
  if (status === "building" || status === "pending" || status === "running")
    return { text: status === "pending" ? "Queued" : "Building", className: "text-amber-400" };
  if (status === "failed")
    return { text: "Error", className: "text-red-400" };
  if (status === "cancelled")
    return { text: "Cancelled", className: "text-slate-500" };
  return { text: status, className: "text-slate-400" };
}

function AppDeploymentsTable({
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
    return (
      <p className="mt-3 text-xs text-slate-500">No deployments yet. Click Deploy.</p>
    );
  }
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800/80">
      <table className="w-full min-w-[640px] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-slate-800 text-slate-500">
            <th className="px-2 py-2 font-medium">Deployment</th>
            <th className="px-2 py-2 font-medium">Status</th>
            <th className="px-2 py-2 font-medium">Git</th>
            <th className="px-2 py-2 font-medium">When</th>
            <th className="w-24 px-2 py-2 text-right font-medium" />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const res = deploymentResultLabel(d.status);
            const isCurrent = currentId != null && d.id === currentId;
            const canRollBackTo =
              d.status === "success" &&
              Boolean(d.imageTag) &&
              !isCurrent;
            return (
              <tr
                key={d.id}
                className="border-b border-slate-800/50 last:border-0"
              >
                <td className="align-top px-2 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono font-medium text-slate-200">
                      {shortDepId(d.id)}
                    </span>
                    {isCurrent ? (
                      <span className="inline-flex items-center gap-0.5 rounded bg-violet-600/20 px-1.5 py-0.5 font-sans text-[10px] text-violet-300">
                        ↑ Current
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="align-top px-2 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={
                        d.status === "success"
                          ? "text-emerald-500"
                          : d.status === "failed"
                            ? "text-red-500"
                            : "text-amber-500"
                      }
                    >
                      ●
                    </span>
                    <span className={res.className}>{res.text}</span>
                  </div>
                  <div className="mt-0.5 font-mono text-slate-500">
                    {formatDuration(d.startedAt, d.finishedAt)}
                  </div>
                </td>
                <td className="align-top px-2 py-2.5">
                  <div className="font-mono text-slate-300">{app.gitBranch}</div>
                  <div className="mt-0.5 break-all text-slate-500">
                    <span className="text-slate-500">{shortCommitSha(d.commitSha)}</span>{" "}
                    <span className="text-slate-400">
                      {d.commitMessage
                        ? truncMsg(d.commitMessage, 64)
                        : d.commitSha
                          ? ""
                          : "—"}
                    </span>
                  </div>
                </td>
                <td className="whitespace-nowrap align-top px-2 py-2.5 text-slate-500">
                  {formatRelativeTime(d.createdAt)}
                </td>
                <td className="align-top px-2 py-2.5 text-right">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={actionsDisabled}
                      className="text-violet-400 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => onViewLog(d.id)}
                    >
                      Log
                    </button>
                    {canRollBackTo ? (
                      <button
                        type="button"
                        disabled={actionsDisabled}
                        className="text-slate-400 hover:text-amber-400 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => onRollBack(d.id)}
                      >
                        Roll back
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 antialiased">
      <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-12">
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  ...rest
}: { label: string; children: ReactNode } & LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className="block text-sm font-medium text-slate-300" {...rest}>
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="mt-0 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none ring-violet-500 placeholder:text-slate-500 focus:border-violet-500 focus:ring-1"
    />
  );
}

function SetupForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useReactState("");
  const [password, setPassword] = useReactState("");
  const [name, setName] = useReactState("");
  const [organizationName, setOrganizationName] = useReactState("");

  const mutation = useMutation({
    mutationFn: () =>
      api("/api/setup", {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          name,
          organizationName
        })
      }),
    onSuccess: () => {
      onSuccess();
    }
  });

  return (
    <Shell>
      <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-8 shadow-xl shadow-black/40 backdrop-blur">
        <h1 className="text-xl font-semibold tracking-tight text-white">
          Welcome to Sohwe
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Create the first organization and owner account for this instance.
        </p>
        <form
          className="mt-8 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="Organization name" htmlFor="org">
            <TextInput
              id="org"
              name="organizationName"
              autoComplete="organization"
              required
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
            />
          </Field>
          <Field label="Your name" htmlFor="name">
            <TextInput
              id="name"
              name="name"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Email" htmlFor="email">
            <TextInput
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" htmlFor="password">
            <TextInput
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {mutation.isError ? (
            <p className="text-sm text-red-400" role="alert">
              {mutation.error instanceof Error
                ? mutation.error.message
                : "Something went wrong"}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={mutation.isPending}
            className="mt-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-50"
          >
            {mutation.isPending ? "Creating…" : "Complete setup"}
          </button>
        </form>
      </div>
    </Shell>
  );
}

function LoginForm() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useReactState("");
  const [password, setPassword] = useReactState("");

  const mutation = useMutation({
    mutationFn: () =>
      api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    }
  });

  return (
    <Shell>
      <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-8 shadow-xl shadow-black/40 backdrop-blur">
        <h1 className="text-xl font-semibold tracking-tight text-white">
          Sign in
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Use the account you created during setup.
        </p>
        <form
          className="mt-8 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="Email" htmlFor="login-email">
            <TextInput
              id="login-email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" htmlFor="login-password">
            <TextInput
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {mutation.isError ? (
            <p className="text-sm text-red-400" role="alert">
              {mutation.error instanceof Error
                ? mutation.error.message
                : "Something went wrong"}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={mutation.isPending}
            className="mt-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-50"
          >
            {mutation.isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </Shell>
  );
}

const baseDomain = "sohwe.localhost";

type FsListEntry = { name: string; kind: "file" | "dir" | "symlink" };
type FsListResponse = { path: string; entries: FsListEntry[] };
type FsFileResponse = {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  truncated: boolean;
  size: number;
};

function joinFsPath(dir: string, name: string): string {
  if (dir === "/") return `/${name}`;
  return `${dir}/${name}`;
}

function parentFsPath(p: string): string {
  if (p === "/") return "/";
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function AppFileBrowser({ appId }: { appId: string }) {
  const [path, setPath] = useState("/");
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["fs-list", appId, path],
    queryFn: () =>
      apiGet<FsListResponse>(
        `/api/applications/${appId}/fs/list?path=${encodeURIComponent(path)}`
      ),
    staleTime: 15_000
  });

  const fileQuery = useQuery({
    queryKey: ["fs-file", appId, previewPath],
    queryFn: () =>
      apiGet<FsFileResponse>(
        `/api/applications/${appId}/fs/file?path=${encodeURIComponent(previewPath!)}`
      ),
    enabled: previewPath != null
  });

  const crumbs = useMemo(() => {
    if (path === "/") return [{ label: "root", path: "/" as const }];
    const segments = path.split("/").filter(Boolean);
    const out: { label: string; path: string }[] = [
      { label: "root", path: "/" }
    ];
    let acc = "";
    for (const seg of segments) {
      acc = `${acc}/${seg}`;
      out.push({ label: seg, path: acc });
    }
    return out;
  }, [path]);

  return (
    <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Container files
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Read-only view of the running container filesystem (no shell required).
      </p>
      <nav
        className="mt-3 flex flex-wrap items-center gap-1 text-xs text-slate-400"
        aria-label="Path"
      >
        {crumbs.map((c, i) => (
          <span key={c.path} className="flex items-center gap-1">
            {i > 0 ? <span className="text-slate-600">/</span> : null}
            <button
              type="button"
              className="rounded px-1 py-0.5 hover:bg-slate-800 hover:text-slate-200"
              onClick={() => setPath(c.path)}
            >
              {c.label}
            </button>
          </span>
        ))}
      </nav>

      {listQuery.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">Loading directory…</p>
      ) : null}
      {listQuery.isError ? (
        <p className="mt-3 text-sm text-red-400" role="alert">
          {listQuery.error instanceof Error
            ? listQuery.error.message
            : "Could not list directory"}
        </p>
      ) : null}

      {listQuery.data ? (
        <ul className="mt-3 max-h-64 space-y-1 overflow-auto font-mono text-sm">
          {path !== "/" ? (
            <li>
              <button
                type="button"
                className="text-slate-400 hover:text-white"
                onClick={() => setPath(parentFsPath(path))}
              >
                ..
              </button>
            </li>
          ) : null}
          {listQuery.data.entries.map((e) => (
            <li key={e.name}>
              {e.kind === "file" ? (
                <button
                  type="button"
                  className="text-violet-400 hover:underline"
                  onClick={() => setPreviewPath(joinFsPath(path, e.name))}
                >
                  {e.name}
                </button>
              ) : (
                <button
                  type="button"
                  className="text-emerald-400 hover:underline"
                  onClick={() => setPath(joinFsPath(path, e.name))}
                >
                  {e.name}
                  {e.kind === "symlink" ? " →" : "/"}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {previewPath ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="File preview"
        >
          <div className="max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
              <p className="truncate font-mono text-sm text-slate-300">
                {previewPath}
              </p>
              <button
                type="button"
                className="rounded-lg border border-slate-600 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
                onClick={() => setPreviewPath(null)}
              >
                Close
              </button>
            </div>
            <div className="max-h-[calc(85vh-4rem)] overflow-auto p-4">
              {fileQuery.isLoading ? (
                <p className="text-sm text-slate-500">Loading file…</p>
              ) : null}
              {fileQuery.isError ? (
                <p className="text-sm text-red-400">
                  {fileQuery.error instanceof Error
                    ? fileQuery.error.message
                    : "Could not read file"}
                </p>
              ) : null}
              {fileQuery.data ? (
                <>
                  <p className="mb-2 text-xs text-slate-500">
                    {fileQuery.data.size} bytes
                    {fileQuery.data.encoding === "base64"
                      ? " · binary (base64)"
                      : " · text"}
                    {fileQuery.data.truncated
                      ? " · preview truncated at 512 KiB"
                      : ""}
                  </p>
                  <pre className="whitespace-pre-wrap break-all font-mono text-xs text-slate-300">
                    {fileQuery.data.content}
                  </pre>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BuildLogStream({ deploymentId }: { deploymentId: string }) {
  const [text, setText] = useState<string>("");

  useEffect(() => {
    const base =
      import.meta.env.DEV || !import.meta.env.VITE_API_URL
        ? ""
        : (import.meta.env.VITE_API_URL as string);
    const es = new EventSource(
      `${base}/api/deployments/${deploymentId}/logs`
    );
    const append = (add: string) => {
      setText((t) => t + add);
    };
    es.onmessage = (ev) => {
      try {
        const j = JSON.parse(ev.data) as
          | { type: "replay"; text: string }
          | { type: "line"; line: string };
        if (j.type === "replay") append(j.text);
        if (j.type === "line") append(`${j.line}\n`);
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      /* browser auto-retries; leave log as-is */
    };
    return () => {
      es.close();
    };
  }, [deploymentId]);

  return (
    <pre className="max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-950/80 p-3 font-mono text-xs text-slate-300">
      {text || "—"}
    </pre>
  );
}

function deploymentStatusLine(status: string | undefined) {
  if (status === "pending") {
    return <span className="text-amber-400">Queued — waiting to start</span>;
  }
  if (status === "building") {
    return <span className="text-amber-400">Building…</span>;
  }
  if (status === "success" || status === "running") {
    return <span className="text-emerald-400">Completed successfully</span>;
  }
  if (status === "failed") {
    return <span className="text-red-400">Failed</span>;
  }
  if (status === "cancelled") {
    return <span className="text-slate-400">Cancelled</span>;
  }
  return <span className="text-slate-500">…</span>;
}

function ApplicationsDashboard({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [cName, setCName] = useState("");
  const [cSlug, setCSlug] = useState("");
  const [cRepo, setCRepo] = useState("");
  const [cBranch, setCBranch] = useState("main");
  const [cPort, setCPort] = useState(3000);
  const [activeLogDeploymentId, setActiveLogDeploymentId] = useState<string | null>(null);
  const [logForApp, setLogForApp] = useState<string | null>(null);
  const [filesForApp, setFilesForApp] = useState<string | null>(null);

  const appsQuery = useQuery({
    queryKey: ["applications"],
    queryFn: () => api<AppRow[]>("/api/applications")
  });

  /** True while the watched deployment is still in progress (worker running). */
  const deployInProgress = useMemo(() => {
    if (!activeLogDeploymentId) return false;
    if (!appsQuery.data) return true;
    const app = appsQuery.data.find((x) => x.id === logForApp);
    if (!app) return true;
    const d = app.deployments?.find((x) => x.id === activeLogDeploymentId);
    if (!d) return true;
    return d.status === "pending" || d.status === "building";
  }, [activeLogDeploymentId, logForApp, appsQuery.data]);

  useEffect(() => {
    if (!activeLogDeploymentId || !deployInProgress) return;
    const t = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
    }, 2000);
    return () => clearInterval(t);
  }, [activeLogDeploymentId, deployInProgress, queryClient]);

  const createMut = useMutation({
    mutationFn: () => {
      const body = CreateApplicationSchema.parse({
        name: cName,
        slug: cSlug,
        gitRepo: cRepo,
        gitBranch: cBranch,
        port: cPort
      });
      return api<AppRow>("/api/applications", {
        method: "POST",
        body: JSON.stringify(body)
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      setCName("");
      setCSlug("");
      setCRepo("");
      setCBranch("main");
      setCPort(3000);
    }
  });

  const deployMut = useMutation({
    mutationFn: (id: string) =>
      api<{ deployment: { id: string } }>(`/api/applications/${id}/deploy`, {
        method: "POST"
      }),
    onSuccess: (data, id) => {
      setLogForApp(id);
      setActiveLogDeploymentId(data.deployment.id);
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
    }
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean }>(`/api/applications/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      setActiveLogDeploymentId(null);
      setLogForApp(null);
    }
  });

  const rollbackMut = useMutation({
    mutationFn: ({
      appId,
      sourceDeploymentId
    }: {
      appId: string;
      sourceDeploymentId: string;
    }) =>
      api<{ deployment: { id: string } }>(
        `/api/applications/${appId}/rollback`,
        {
          method: "POST",
          body: JSON.stringify({ sourceDeploymentId })
        }
      ),
    onSuccess: (data, { appId }) => {
      setLogForApp(appId);
      setActiveLogDeploymentId(data.deployment.id);
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
    }
  });

  const logout = useMutation({
    mutationFn: () => api("/api/auth/logout", { method: "POST" }),
    onSuccess: () => {
      queryClient.setQueryData(["me"], null);
    }
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 antialiased">
      <header className="border-b border-slate-800 bg-slate-900/50">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Sohwe
            </p>
            <p className="text-sm text-slate-300">{me.organization.name}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-400">
              {me.name ?? me.email}
            </span>
            <button
              type="button"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
              className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-10 px-4 py-10">
        <h1 className="text-2xl font-semibold text-white">Applications</h1>
        <p className="text-slate-400">
          Phase 1: public Git URLs with a Dockerfile at the repo root. Live URL:{" "}
          <code className="text-slate-300">&lt;slug&gt;.{baseDomain}</code>
        </p>

        <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
          <h2 className="text-sm font-medium text-slate-200">New application</h2>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              createMut.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <TextInput
                  value={cName}
                  onChange={(e) => setCName(e.target.value)}
                  required
                />
              </Field>
              <Field label="Slug (subdomain)">
                <TextInput
                  value={cSlug}
                  onChange={(e) => setCSlug(e.target.value.toLowerCase())}
                  required
                  pattern="[a-z0-9-]+"
                />
              </Field>
            </div>
            <Field label="Public Git URL (https)">
              <TextInput
                value={cRepo}
                onChange={(e) => setCRepo(e.target.value)}
                required
                type="url"
                placeholder="https://github.com/org/repo"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Branch">
                <TextInput
                  value={cBranch}
                  onChange={(e) => setCBranch(e.target.value)}
                  required
                />
              </Field>
              <Field label="Container port">
                <TextInput
                  type="number"
                  value={cPort}
                  onChange={(e) => setCPort(Number(e.target.value))}
                  min={1}
                  max={65535}
                />
              </Field>
            </div>
            {createMut.isError ? (
              <p className="text-sm text-red-400">
                {createMut.error instanceof Error
                  ? createMut.error.message
                  : "Error"}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={createMut.isPending}
              className="w-fit rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
            >
              {createMut.isPending ? "Creating…" : "Add application"}
            </button>
          </form>
        </section>

        <section>
          <h2 className="text-sm font-medium text-slate-200">Your apps</h2>
          {appsQuery.isLoading ? (
            <p className="mt-3 text-slate-500">Loading…</p>
          ) : null}
          {appsQuery.isError ? (
            <p className="mt-3 text-red-400">Failed to load applications.</p>
          ) : null}
          <ul className="mt-4 space-y-4">
            {(appsQuery.data ?? []).map((a) => {
              const appUrl = `http://${a.slug}.${baseDomain}`;
              const showLogs =
                logForApp === a.id && activeLogDeploymentId;
              const watchingDep =
                showLogs && activeLogDeploymentId
                  ? a.deployments?.find(
                      (d) => d.id === activeLogDeploymentId
                    )
                  : undefined;
              return (
                <li
                  key={a.id}
                  className="rounded-xl border border-slate-800 bg-slate-900/40 p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <h3 className="font-medium text-white">{a.name}</h3>
                      <p className="text-xs text-slate-500">{a.status}</p>
                    </div>
                    <a
                      href={appUrl}
                      className="text-sm text-violet-400 hover:underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {a.slug}.{baseDomain}
                    </a>
                  </div>
                  <p className="mt-2 font-mono text-xs text-slate-500 break-all">
                    {a.gitRepo} <span className="text-slate-600">@</span>{" "}
                    {a.gitBranch} · :{a.port}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={
                        a.status === "deploying" ||
                        (deployMut.isPending && deployMut.variables === a.id) ||
                        (rollbackMut.isPending &&
                          rollbackMut.variables?.appId === a.id) ||
                        deleteMut.isPending
                      }
                      onClick={() => deployMut.mutate(a.id)}
                      className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm text-white hover:bg-emerald-600 disabled:opacity-50"
                    >
                      {a.status === "deploying" || (deployMut.isPending && deployMut.variables === a.id)
                        ? "Deploying…"
                        : "Deploy"}
                    </button>
                    {a.status === "running" ? (
                      <button
                        type="button"
                        onClick={() =>
                          setFilesForApp(filesForApp === a.id ? null : a.id)
                        }
                        className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                      >
                        {filesForApp === a.id ? "Hide files" : "Browse files"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={deleteMut.isPending}
                      onClick={() => {
                        if (confirm("Delete this application and its containers?"))
                          deleteMut.mutate(a.id);
                      }}
                      className="rounded-md border border-red-900/50 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/40"
                    >
                      Delete
                    </button>
                  </div>
                  <h4 className="mt-5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    Deployments
                  </h4>
                  <AppDeploymentsTable
                    app={a}
                    actionsDisabled={
                      a.status === "deploying" ||
                      (deployMut.isPending && deployMut.variables === a.id) ||
                      (rollbackMut.isPending &&
                        rollbackMut.variables?.appId === a.id) ||
                      deleteMut.isPending
                    }
                    onViewLog={(depId) => {
                      setLogForApp(a.id);
                      setActiveLogDeploymentId(depId);
                    }}
                    onRollBack={(sourceDeploymentId) => {
                      if (
                        !confirm(
                          "Roll back to this build? The app will restart using that image."
                        )
                      ) {
                        return;
                      }
                      rollbackMut.mutate({ appId: a.id, sourceDeploymentId });
                    }}
                  />
                  {showLogs && activeLogDeploymentId ? (
                    <div className="mt-4 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-slate-500">Build log</span>
                        <span className="text-slate-600" aria-hidden>
                          ·
                        </span>
                        {deploymentStatusLine(watchingDep?.status)}
                      </div>
                      {watchingDep?.status === "failed" && watchingDep.errorMessage ? (
                        <p className="text-xs text-red-400/90">
                          {watchingDep.errorMessage}
                        </p>
                      ) : null}
                      <BuildLogStream
                        key={activeLogDeploymentId}
                        deploymentId={activeLogDeploymentId}
                      />
                    </div>
                  ) : null}
                  {filesForApp === a.id && a.status === "running" ? (
                    <AppFileBrowser appId={a.id} />
                  ) : null}
                </li>
              );
            })}
          </ul>
          {appsQuery.data?.length === 0 ? (
            <p className="mt-4 text-slate-500">No applications yet.</p>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function Loading() {
  return (
    <Shell>
      <p className="text-center text-slate-400">Loading…</p>
    </Shell>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <Shell>
      <div
        className="rounded-xl border border-red-900/50 bg-red-950/40 p-6 text-center text-red-200"
        role="alert"
      >
        <p className="font-medium">Could not reach the API</p>
        <p className="mt-2 text-sm text-red-300/90">{message}</p>
      </div>
    </Shell>
  );
}

export default function App() {
  const queryClient = useQueryClient();

  const setupQuery = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => api<SetupStatus>("/api/setup/status")
  });

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => fetchMe<Me>(),
    enabled: setupQuery.isSuccess && !setupQuery.data.needsSetup,
    retry: false
  });

  if (setupQuery.isPending) {
    return <Loading />;
  }

  if (setupQuery.isError) {
    return (
      <LoadError
        message={
          setupQuery.error instanceof Error
            ? setupQuery.error.message
            : "Unknown error"
        }
      />
    );
  }

  if (setupQuery.data.needsSetup) {
    return (
      <SetupForm
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: ["setup", "status"] });
        }}
      />
    );
  }

  if (meQuery.isPending) {
    return <Loading />;
  }

  if (meQuery.isError) {
    return (
      <LoadError
        message={
          meQuery.error instanceof Error
            ? meQuery.error.message
            : "Unknown error"
        }
      />
    );
  }

  if (meQuery.data) {
    return <ApplicationsDashboard me={meQuery.data} />;
  }

  return <LoginForm />;
}
