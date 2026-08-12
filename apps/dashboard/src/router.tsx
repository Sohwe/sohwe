import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { fetchMe } from "@/lib/api";
import { fetchSetupStatus } from "@/lib/setup-queries";
import type { Me, SetupStatus } from "@/lib/types";
import { AuthedLayout } from "@/components/layout/AuthedLayout";
import { SetupPage } from "@/routes/setup";
import { LoginPage } from "@/routes/login";
import { AppsListPage } from "@/routes/apps.index";
import { AppLayout } from "@/routes/app.$appId";
import { AppOverviewPage } from "@/routes/app.$appId.overview";
import { AppVariablesPage } from "@/routes/app.$appId.variables";
import { AppVolumesPage } from "@/routes/app.$appId.volumes";
import { AppLogsPage } from "@/routes/app.$appId.logs";
import { AppMetricsPage } from "@/routes/app.$appId.metrics";
import { AppFilesPage } from "@/routes/app.$appId.files";
import { AppSettingsPage } from "@/routes/app.$appId.settings";
import { BackupsPage } from "@/routes/backups";
import { GitPage } from "@/routes/git";
import { JoinPage } from "@/routes/join";
import { MembersPage } from "@/routes/members";
import { AuditPage } from "@/routes/audit";
import { DeploymentsPage } from "@/components/apps/DeploymentsPage";

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => <Outlet />
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async ({ context: { queryClient } }) => {
    const s = await queryClient.fetchQuery<SetupStatus>({
      queryKey: ["setup", "status"],
      queryFn: fetchSetupStatus,
      staleTime: 10_000
    });
    if (s.needsSetup) throw redirect({ to: "/setup" });
    const me = await queryClient.fetchQuery<Me | null>({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() });
    if (!me) throw redirect({ to: "/login" });
    throw redirect({ to: "/apps" });
  }
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup",
  beforeLoad: async ({ context: { queryClient } }) => {
    const s = await queryClient.fetchQuery<SetupStatus>({
      queryKey: ["setup", "status"],
      queryFn: fetchSetupStatus
    });
    if (!s.needsSetup) {
      const me = await queryClient.fetchQuery<Me | null>({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() });
      if (me) throw redirect({ to: "/apps" });
      throw redirect({ to: "/login" });
    }
  },
  component: SetupPage
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "login",
  beforeLoad: async ({ context: { queryClient } }) => {
    const s = await queryClient.fetchQuery<SetupStatus>({
      queryKey: ["setup", "status"],
      queryFn: fetchSetupStatus
    });
    if (s.needsSetup) throw redirect({ to: "/setup" });
    const me = await queryClient.fetchQuery<Me | null>({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() });
    if (me) throw redirect({ to: "/apps" });
  },
  component: LoginPage
});

const authedLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: async ({ context: { queryClient } }) => {
    const s = await queryClient.fetchQuery<SetupStatus>({
      queryKey: ["setup", "status"],
      queryFn: fetchSetupStatus
    });
    if (s.needsSetup) throw redirect({ to: "/setup" });
    const me = await queryClient.fetchQuery<Me | null>({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() });
    if (!me) throw redirect({ to: "/login" });
  },
  component: AuthedLayout
});

const appsLayoutRoute = createRoute({
  getParentRoute: () => authedLayoutRoute,
  path: "apps",
  component: () => <Outlet />
});

const appsIndexRoute = createRoute({
  getParentRoute: () => appsLayoutRoute,
  path: "/",
  component: AppsListPage
});

const appLayoutRoute = createRoute({
  getParentRoute: () => appsLayoutRoute,
  path: "$appId",
  component: AppLayout
});

const backupsRoute = createRoute({
  getParentRoute: () => authedLayoutRoute,
  path: "backups",
  component: BackupsPage
});

const gitRoute = createRoute({
  getParentRoute: () => authedLayoutRoute,
  path: "git",
  component: GitPage
});

const membersRoute = createRoute({
  getParentRoute: () => authedLayoutRoute,
  path: "members",
  component: MembersPage
});

const auditRoute = createRoute({
  getParentRoute: () => authedLayoutRoute,
  path: "audit",
  component: AuditPage
});

/**
 * Redeeming an invitation. Sits outside the authed layout: the invitee has no
 * account yet, and unlike /login it must stay reachable while signed out
 * without bouncing to the sign-in form.
 */
const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "join",
  component: JoinPage
});

const appIdIndexRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/apps/$appId/overview", params: { appId: params.appId } });
  }
});

const appOverviewRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "overview",
  component: AppOverviewPage
});

const appVariablesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "variables",
  component: AppVariablesPage
});

const appVolumesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "volumes",
  component: AppVolumesPage
});

const appLogsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "logs",
  component: AppLogsPage
});

const appMetricsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "metrics",
  component: AppMetricsPage
});

const appFilesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "files",
  component: AppFilesPage
});

const appSettingsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "settings",
  component: AppSettingsPage
});

const deploymentsLayoutRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "deployments",
  component: () => <Outlet />
});

const deploymentsIndexRoute = createRoute({
  getParentRoute: () => deploymentsLayoutRoute,
  path: "/",
  component: DeploymentsPage
});

const deploymentsWithIdRoute = createRoute({
  getParentRoute: () => deploymentsLayoutRoute,
  path: "$deploymentId",
  component: DeploymentsPage
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  setupRoute,
  loginRoute,
  joinRoute,
  authedLayoutRoute.addChildren([
    appsLayoutRoute.addChildren([
      appsIndexRoute,
      appLayoutRoute.addChildren([
        appIdIndexRoute,
        appOverviewRoute,
        appVariablesRoute,
        appVolumesRoute,
        appLogsRoute,
        appMetricsRoute,
        appFilesRoute,
        appSettingsRoute,
        deploymentsLayoutRoute.addChildren([deploymentsIndexRoute, deploymentsWithIdRoute])
      ])
    ]),
    backupsRoute,
    gitRoute,
    membersRoute,
    auditRoute
  ])
]);

export function buildRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient } });
}

/** Typing: pass the router returned by `buildRouter` */
export type SohweRouter = ReturnType<typeof buildRouter>;
