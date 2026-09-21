import { type LabelHTMLAttributes, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function Field({
  label,
  children,
  className,
  ...rest
}: { label: string; children: ReactNode; className?: string } & LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <Label className={cn("grid gap-2", className)} {...rest}>
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
    </Label>
  );
}
