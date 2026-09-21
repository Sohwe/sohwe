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
    <div className="flex h-svh w-full overflow-hidden bg-background">
      <AppSidebar me={me} collapsed={collapsed} onToggleCollapse={() => setCollapsed((c) => !c)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar me={me} />
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6 md:px-8 md:py-7">
          <div className="mx-auto w-full max-w-[1280px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
