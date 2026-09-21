import { Link, useLocation } from "@tanstack/react-router";
import {
  Box,
  Boxes,
  Database,
  DatabaseBackup,
  GitBranch,
  HardDrive,
  LayoutGrid,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Users
} from "lucide-react";
import { useState, type ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppConfig } from "@/lib/config";
import { isAdmin, ROLE_LABEL } from "@/lib/roles";
import type { Me } from "@/lib/types";

type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  adminOnly?: boolean;
};

const workspaceItems: NavItem[] = [
  { to: "/apps", label: "Applications", icon: LayoutGrid },
  { to: "/projects", label: "Projects", icon: Boxes },
  { to: "/datastores", label: "Datastores", icon: Database, adminOnly: true }
];

const manageItems: NavItem[] = [
  { to: "/git", label: "Git provider", icon: GitBranch, adminOnly: true },
  { to: "/backups", label: "Backups", icon: DatabaseBackup, adminOnly: true },
  { to: "/host-files", label: "Host files", icon: HardDrive, adminOnly: true },
  { to: "/members", label: "Members", icon: Users },
  { to: "/audit", label: "Audit log", icon: ScrollText, adminOnly: true }
];

function isItemActive(pathname: string, to: string) {
  if (to === "/apps") return pathname === "/apps" || pathname.startsWith("/apps/");
  return pathname === to || pathname.startsWith(`${to}/`);
}

function SidebarLink({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const active = isItemActive(pathname, item.to);
  const Icon = item.icon;
  const link = (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-9 items-center rounded-md text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/45",
        collapsed ? "w-9 justify-center" : "gap-3 px-2.5",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-muted hover:bg-sidebar-accent/70 hover:text-sidebar-foreground"
      )}
    >
      {active ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-primary" /> : null}
      <Icon className={cn("h-4 w-4 shrink-0", active && "text-primary")} />
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
    </Link>
  );

  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>{item.label}</TooltipContent>
    </Tooltip>
  );
}

function NavGroup({ label, items, me, collapsed, onNavigate }: { label: string; items: NavItem[]; me: Me; collapsed: boolean; onNavigate?: () => void }) {
  const visible = items.filter((item) => !item.adminOnly || isAdmin(me));
  return (
    <div className="space-y-1">
      {!collapsed ? (
        <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted/70">{label}</p>
      ) : null}
      {visible.map((item) => <SidebarLink key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />)}
    </div>
  );
}

function SidebarBody({ me, collapsed, onNavigate }: { me: Me; collapsed: boolean; onNavigate?: () => void }) {
  return (
    <nav className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden py-3", collapsed ? "items-center px-2" : "px-2.5")}>
      <NavGroup label="Workspace" items={workspaceItems} me={me} collapsed={collapsed} onNavigate={onNavigate} />
      <NavGroup label="Manage" items={manageItems} me={me} collapsed={collapsed} onNavigate={onNavigate} />
    </nav>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <Link to="/apps" className={cn("flex h-14 shrink-0 items-center", collapsed ? "justify-center" : "px-4")}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm shadow-primary/20">
        <Box className="h-[18px] w-[18px]" strokeWidth={2.25} />
      </span>
      {!collapsed ? <span className="ml-2.5 text-[15px] font-semibold tracking-[-0.02em] text-sidebar-foreground">Sohwe</span> : null}
    </Link>
  );
}

function SidebarFooter({ me, collapsed }: { me: Me; collapsed: boolean }) {
  const { version } = useAppConfig();
  if (collapsed) {
    return (
      <div className="flex shrink-0 justify-center border-t border-sidebar-border p-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-accent text-[11px] font-semibold text-sidebar-foreground" title={`${me.organization.name} · ${version}`}>
          {me.organization.name.slice(0, 1).toUpperCase()}
        </span>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-sidebar-border p-3">
      <div className="flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-[11px] font-semibold text-sidebar-foreground">
          {me.organization.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-sidebar-foreground">{me.organization.name}</p>
          <p className="truncate text-[11px] text-sidebar-muted">{me.name ?? me.email} · {ROLE_LABEL[me.role] ?? me.role}</p>
        </div>
        <code className="shrink-0 text-[9px] text-sidebar-muted/70">{version}</code>
      </div>
    </div>
  );
}

export function AppSidebar({ me, collapsed, onToggleCollapse }: { me: Me; collapsed: boolean; onToggleCollapse: () => void }) {
  return (
    <aside className={cn("relative hidden h-svh shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out md:flex", collapsed ? "w-[60px]" : "w-60")}>
      <div className="flex shrink-0 items-center border-b border-sidebar-border">
        <div className="min-w-0 flex-1"><Brand collapsed={collapsed} /></div>
        {!collapsed ? (
          <Button variant="ghost" size="icon" className="mr-2 h-8 w-8 text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground" onClick={onToggleCollapse} aria-label="Collapse sidebar">
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
      {collapsed ? (
        <Button variant="ghost" size="icon" className="mx-auto mt-2 h-9 w-9 shrink-0 text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground" onClick={onToggleCollapse} aria-label="Expand sidebar">
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
      ) : null}
      <SidebarBody me={me} collapsed={collapsed} />
      <SidebarFooter me={me} collapsed={collapsed} />
    </aside>
  );
}

export function MobileNav({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation"><Menu className="h-4 w-4" /></Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-[min(19rem,88vw)] flex-col border-sidebar-border bg-sidebar p-0 text-sidebar-foreground">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SheetDescription className="sr-only">Navigate between Sohwe workspace and administration pages.</SheetDescription>
        <div className="border-b border-sidebar-border"><Brand collapsed={false} /></div>
        <SidebarBody me={me} collapsed={false} onNavigate={() => setOpen(false)} />
        <SidebarFooter me={me} collapsed={false} />
      </SheetContent>
    </Sheet>
  );
}
