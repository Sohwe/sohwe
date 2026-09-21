import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border border-transparent px-2.5 py-0.5 text-[11px] font-medium leading-5 transition-colors focus:outline-none focus:ring-2 focus:ring-ring/30",
  {
    variants: {
      variant: {
        default: "border-primary/15 bg-primary/10 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-destructive/15 bg-destructive/10 text-destructive",
        outline: "border-border/80 text-foreground",
        success: "border-emerald-500/15 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        warning: "border-amber-500/15 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

export type BadgeProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
