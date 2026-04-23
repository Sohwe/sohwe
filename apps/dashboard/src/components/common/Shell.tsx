import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Shell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "min-h-svh w-full flex flex-col items-center justify-center border-border bg-background px-4 py-12 antialiased",
        "dark:bg-zinc-950/80"
      )}
    >
      <div className={cn("mx-auto w-full max-w-md", className)}>{children}</div>
    </div>
  );
}
