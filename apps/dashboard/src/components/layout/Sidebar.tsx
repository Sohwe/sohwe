import { Link, useLocation } from "@tanstack/react-router";
import { Box, ChevronsLeft, ChevronsRight, DatabaseBackup, GitBranch, LayoutGrid, Menu } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import type { Me } from "@/lib/types";

function NavLink({
  to,
  icon: Icon,
  children,
  onClick
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  const { pathname } = useLocation();
  const active =
    to === "/apps" ? pathname === "/apps" || pathname.startsWith("/apps/") : pathname === to || pathname.startsWith(`${to}/`);
  return (
    <Link
      to={to}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        active && "bg-accent text-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {children}
    </Link>
  );
}

function SidebarContent({ onNavigate, me }: { onNavigate?: () => void; me: Me }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center border-b border-border px-3">
        <Box className="h-5 w-5 text-primary" />
        <span className="ml-2 font-semibold tracking-tight">Sohwe</span>
      </div>
      <nav className="flex-1 space-y-0.5 p-2">
        <NavLink to="/apps" icon={LayoutGrid} onClick={onNavigate}>
          Applications
        </NavLink>
        <NavLink to="/git" icon={GitBranch} onClick={onNavigate}>
          Git
        </NavLink>
        <NavLink to="/backups" icon={DatabaseBackup} onClick={onNavigate}>
          Backups
        </NavLink>
      </nav>
      <Separator />
      <div className="p-2 text-xs text-muted-foreground">
        <p className="truncate font-medium text-foreground/90">{me.organization.name}</p>
        <p className="mt-0.5 truncate">{me.name ?? me.email}</p>
      </div>
    </div>
  );
}

export function AppSidebar({ me, collapsed, onToggleCollapse }: { me: Me; collapsed: boolean; onToggleCollapse: () => void }) {
  return (
    <aside
      className={cn(
        "hidden h-svh border-r border-border bg-card md:flex md:flex-col",
        collapsed ? "w-16" : "w-56"
      )}
    >
      {collapsed ? (
        <div className="flex h-full flex-col items-center py-2">
          <Button variant="ghost" size="icon" className="mb-2" onClick={onToggleCollapse} title="Expand">
            <ChevronsRight className="h-4 w-4" />
          </Button>
          <Link
            to="/apps"
            className="flex h-9 w-9 items-center justify-center rounded-md text-primary hover:bg-accent"
            title="Applications"
          >
            <LayoutGrid className="h-4 w-4" />
          </Link>
          <Link
            to="/git"
            className="mt-1 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            title="Git"
          >
            <GitBranch className="h-4 w-4" />
          </Link>
          <Link
            to="/backups"
            className="mt-1 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            title="Backups"
          >
            <DatabaseBackup className="h-4 w-4" />
          </Link>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-end border-b border-border p-1">
            <Button variant="ghost" size="icon" onClick={onToggleCollapse} title="Collapse" className="h-8 w-8">
              <ChevronsLeft className="h-4 w-4" />
            </Button>
          </div>
          <SidebarContent me={me} />
        </>
      )}
    </aside>
  );
}

export function MobileNav({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon" className="md:hidden" aria-label="Open menu">
          <Menu className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 p-0">
        <SheetHeader className="border-b border-border p-3 text-left">
          <SheetTitle className="text-base">Sohwe</SheetTitle>
        </SheetHeader>
        <div className="h-[calc(100%-4rem)]">
          <SidebarContent me={me} onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
