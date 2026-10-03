import type { VariableScope } from "@sohwe/types";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SCOPE_LABEL } from "./scoped-variable-utils";

export function BuildAccess({
  scope,
  onChange,
  disabled,
  variableKey
}: {
  scope: VariableScope;
  onChange: (scope: VariableScope) => void;
  disabled?: boolean;
  variableKey?: string;
}) {
  if (scope === "build") {
    return <ScopeSelect value={scope} onChange={onChange} disabled={disabled} />;
  }
  return (
    <label className="flex items-center gap-2 text-xs">
      <Checkbox
        checked={scope === "both"}
        disabled={disabled}
        aria-label={variableKey ? `Also available during build for ${variableKey}` : undefined}
        onChange={(event) => onChange(event.target.checked ? "both" : "runtime")}
      />
      Also available during build
    </label>
  );
}

export function ScopeSelect({
  value,
  onChange,
  disabled,
  className
}: {
  value: VariableScope;
  onChange: (s: VariableScope) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as VariableScope)} disabled={disabled}>
      <SelectTrigger className={className ?? "h-8 w-[9.5rem] text-xs"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(["both", "runtime", "build"] as const).map((scope) => (
          <SelectItem key={scope} value={scope}>
            {SCOPE_LABEL[scope]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
