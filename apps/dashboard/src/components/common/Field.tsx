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
    <Label className={cn("grid gap-1.5", className)} {...rest}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </Label>
  );
}
