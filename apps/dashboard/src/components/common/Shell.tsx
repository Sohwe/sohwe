import { type ReactNode } from "react";
import { Box } from "lucide-react";
import { cn } from "@/lib/utils";

export function Shell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative min-h-svh w-full flex flex-col items-center justify-center overflow-hidden border-border bg-background px-4 py-12 antialiased",
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-72 before:bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.12),transparent_70%)]"
      )}
    >
      <div className={cn("relative mx-auto w-full max-w-md", className)}>
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <Box className="h-5 w-5" strokeWidth={2.25} />
          </span>
          <span className="text-lg font-semibold tracking-[-0.025em]">Sohwe</span>
        </div>
        {children}
        <p className="mt-6 text-center text-[11px] text-muted-foreground/70">Your infrastructure. Your deployments.</p>
      </div>
    </div>
  );
}
