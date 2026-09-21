import { type ReactNode } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

export function Section({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("surface-highlight rounded-xl border border-border/80 bg-card shadow-panel", className)}>{children}</section>;
}

export function SectionHeader({ title, description, actions, className }: { title: string; description?: string; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 border-b border-border/70 px-5 py-4 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
        {description ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("p-5", className)}>{children}</div>;
}

export function ResourceRow({ children, className, asChild = false }: { children: ReactNode; className?: string; asChild?: boolean }) {
  const Component = asChild ? Slot : "div";
  return <Component className={cn("flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-card/70 px-4 py-3 transition-colors hover:border-border hover:bg-muted/20", className)}>{children}</Component>;
}

export function ResourceList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn("space-y-2", className)}>{children}</ul>;
}

export function ResourceItem({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn("flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 px-4 py-3 transition-colors hover:border-border hover:bg-muted/30", className)}>{children}</li>;
}

export function Notice({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "warning" | "danger" | "success"; className?: string }) {
  return (
    <div className={cn(
      "rounded-lg border px-4 py-3 text-sm leading-relaxed",
      tone === "neutral" && "border-border/70 bg-muted/30 text-muted-foreground",
      tone === "warning" && "border-amber-500/25 bg-amber-500/8 text-amber-800 dark:text-amber-300",
      tone === "danger" && "border-destructive/25 bg-destructive/8 text-destructive",
      tone === "success" && "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
      className
    )}>{children}</div>
  );
}
