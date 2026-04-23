import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import { AppSidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { fetchMe } from "@/lib/api";
import type { Me } from "@/lib/types";

const COLLAPSE_KEY = "sohwe-sidebar-collapsed";

export function AuthedLayout() {
  const { data: me, isPending } = useQuery({ queryKey: ["me"], queryFn: () => fetchMe<Me | null>() });
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (!e.metaKey && !e.ctrlKey && e.key === "c") {
        window.dispatchEvent(new CustomEvent("sohwe:open-create-app"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (isPending || !me) {
    return (
      <div className="flex min-h-svh items-center justify-center border-border bg-background p-4 text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex min-h-svh w-full bg-background">
      <AppSidebar me={me} collapsed={collapsed} onToggleCollapse={() => setCollapsed((c) => !c)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar me={me} />
        <div className="flex-1 overflow-auto p-4 md:p-6">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
