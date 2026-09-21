import { Inbox, type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
  className
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div
      className={cn("flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center", className)}
    >
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-border/70 bg-muted/50 text-muted-foreground">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <h3 className="text-sm font-semibold tracking-[-0.01em]">{title}</h3>
      {description ? <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
