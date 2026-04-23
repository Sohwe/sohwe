import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7", className)}
      title={label ?? "Copy"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          toast.success("Copied to clipboard");
          setTimeout(() => setOk(false), 1500);
        } catch {
          toast.error("Could not copy");
        }
      }}
    >
      {ok ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}
