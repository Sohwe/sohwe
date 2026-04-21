import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useState,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode
} from "react";
import { api, fetchMe } from "./lib/api";

type SetupStatus = { needsSetup: boolean };

type Me = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  organization: { id: string; name: string };
};

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

function SetupForm({
  onSuccess
}: {
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

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

function Dashboard({ me }: { me: Me }) {
  const queryClient = useQueryClient();

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
      <main className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="text-2xl font-semibold text-white">Dashboard</h1>
        <p className="mt-2 max-w-md text-slate-400">
          You&apos;re signed in. Application management will appear in later
          phases.
        </p>
        <div className="mt-10 rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-10 text-center text-sm text-slate-500">
          No applications yet
        </div>
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
    return <Dashboard me={meQuery.data} />;
  }

  return <LoginForm />;
}
