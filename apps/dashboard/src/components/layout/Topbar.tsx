import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { ChevronRight, LogOut, Moon, Sun, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useTheme } from "./ThemeProvider";
import { MobileNav } from "./Sidebar";
import type { AppRow, Me } from "@/lib/types";
import { shortDepId } from "@/lib/format";

function tabLabel(tab: string | undefined, sub: string | undefined): string {
  if (!tab) return "Overview";
  if (tab === "overview") return "Overview";
  if (tab === "deployments" && !sub) return "Deployments";
  if (tab === "deployments" && sub) return `Log ${shortDepId(sub)}`;
  if (tab === "logs") return "Logs";
  if (tab === "variables") return "Variables";
  if (tab === "volumes") return "Volumes";
  if (tab === "files") return "Files";
  if (tab === "settings") return "Settings";
  return tab;
}

export function Topbar({ me }: { me: Me }) {
  const { pathname } = useLocation();
  const { theme, toggle } = useTheme();
  const queryClient = useQueryClient();

  const appId = useMemo(() => pathname.match(/^\/apps\/([^/]+)/)?.[1], [pathname]);
  const appsQuery = useQuery({
    queryKey: ["applications"],
    queryFn: () => api<AppRow[]>("/api/applications"),
    enabled: Boolean(appId),
    staleTime: 30_000
  });
  const app = appId ? appsQuery.data?.find((a) => a.id === appId) : undefined;

  const { segments, appNameLabel } = useMemo(() => {
    const s = pathname.split("/").filter(Boolean);
    if (s[0] === "apps" && s[1]) {
      return {
        segments: s,
        appNameLabel: app?.name ?? "Application"
      };
    }
    return { segments: s, appNameLabel: "Application" as string | undefined };
  }, [pathname, app?.name]);

  const crumbs = useMemo(() => {
    if (segments[0] === "apps" && segments.length === 1) {
      return [{ label: "Applications" }];
    }
    if (segments[0] === "apps" && segments[1]) {
      const id = segments[1];
      const tab = segments[2];
      const sub = segments[3];
      const cl: { label: string; to?: "apps" | "app" | "tab"; appIdParam?: string }[] = [
        { label: "Applications", to: "apps" }
      ];
      cl.push({ label: appNameLabel ?? "App", to: "app", appIdParam: id });
      if (tab) {
        cl.push({ label: tabLabel(tab, sub) });
      }
      return cl;
    }
    return [{ label: "Sohwe" }];
  }, [segments, appNameLabel]);

  const logout = useMutation({
    mutationFn: () => api("/api/auth/logout", { method: "POST" }),
    onSuccess: () => {
      queryClient.setQueryData(["me"], null);
      void queryClient.invalidateQueries();
      window.location.assign("/login");
    }
  });

  return (
    <header
      className={cn(
        "sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur",
        "supports-[backdrop-filter]:bg-background/75"
      )}
    >
      <div className="flex items-center gap-2 md:hidden">
        <MobileNav me={me} />
      </div>
      <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm" aria-label="Breadcrumb">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <div key={i} className="flex min-w-0 items-center gap-1">
              {i > 0 ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
              {"to" in c && c.to === "apps" ? (
                <Link to="/apps" className="truncate text-muted-foreground hover:text-foreground">
                  {c.label}
                </Link>
              ) : "to" in c && c.to === "app" && c.appIdParam ? (
                <Link
                  to="/apps/$appId/overview"
                  params={{ appId: c.appIdParam }}
                  className="max-w-[10rem] truncate text-muted-foreground hover:text-foreground sm:max-w-xs"
                >
                  {c.label}
                </Link>
              ) : (
                <span
                  className={cn("truncate", isLast ? "font-medium text-foreground" : "text-muted-foreground")}
                >
                  {c.label}
                </span>
              )}
            </div>
          );
        })}
      </nav>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="ghost" size="icon" onClick={toggle} title={theme === "dark" ? "Light" : "Dark"}>
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="rounded-full" title="Account">
              <User className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <p className="text-xs text-muted-foreground">Signed in</p>
              <p className="font-medium text-foreground">{me.name ?? me.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => logout.mutate()} disabled={logout.isPending}>
              <LogOut className="mr-2 h-3.5 w-3.5" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
