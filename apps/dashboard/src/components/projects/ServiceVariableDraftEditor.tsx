import { useState } from "react";
import type { VariableEntry, VariableScope } from "@sohwe/types";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

function looksSensitive(key: string) {
  const normalized = key.toUpperCase();
  return /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|DATABASE_URL|REDIS_URL|_DSN)/.test(normalized)
    && !/^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_)/.test(normalized);
}

function ScopeControl({
  scope,
  onChange
}: {
  scope: VariableScope;
  onChange: (scope: VariableScope) => void;
}) {
  if (scope === "build") {
    return (
      <Select value={scope} onValueChange={(value) => onChange(value as VariableScope)}>
        <SelectTrigger className="w-40 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="runtime">Runtime only</SelectItem>
          <SelectItem value="both">Build + runtime</SelectItem>
          <SelectItem value="build">Build only</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  return (
    <label className="flex items-center gap-2 text-xs">
      <Checkbox
        checked={scope === "both"}
        onChange={(event) => onChange(event.target.checked ? "both" : "runtime")}
      />
      Also available during build
    </label>
  );
}

export function ServiceVariableDraftEditor({
  entries,
  onChange
}: {
  entries: VariableEntry[];
  onChange: (entries: VariableEntry[]) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<VariableScope>("runtime");
  const [bulk, setBulk] = useState("");
  const [bulkScope, setBulkScope] = useState<VariableScope>("runtime");

  function add(next: VariableEntry[]) {
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    for (const entry of next) byKey.set(entry.key, entry);
    onChange([...byKey.values()]);
  }

  return (
    <div className="space-y-3 rounded-md border p-3 sm:col-span-3">
      <div>
        <p className="text-sm font-medium">Service variables</p>
        <p className="text-xs text-muted-foreground">
          Available at runtime by default. Enable build access only when needed.
        </p>
      </div>
      {entries.map((entry) => (
        <div key={entry.key} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/30 p-2">
          <span className="min-w-32 font-mono text-xs">{entry.key}</span>
          <Input
            className="h-8 min-w-40 flex-1 font-mono text-xs"
            value={entry.value}
            onChange={(event) =>
              onChange(entries.map((item) => item.key === entry.key ? { ...item, value: event.target.value } : item))
            }
            aria-label={`Value for ${entry.key}`}
          />
          <ScopeControl
            scope={entry.scope}
            onChange={(nextScope) =>
              onChange(entries.map((item) => item.key === entry.key ? { ...item, scope: nextScope } : item))
            }
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange(entries.filter((item) => item.key !== entry.key))}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          value={key}
          onChange={(event) => setKey(event.target.value.toUpperCase())}
          placeholder="KEY"
          aria-label="Variable key"
        />
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Value"
          aria-label="Variable value"
        />
      </div>
      <ScopeControl scope={scope} onChange={setScope} />
      {scope !== "runtime" && looksSensitive(key) ? (
        <p className="text-xs text-destructive">
          {key} looks like a credential. Build access can expose it in the image.
        </p>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer">Advanced scope options</summary>
        <div className="mt-2">
          <Select value={scope} onValueChange={(next) => setScope(next as VariableScope)}>
            <SelectTrigger className="w-40 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="runtime">Runtime only</SelectItem>
              <SelectItem value="both">Build + runtime</SelectItem>
              <SelectItem value="build">Build only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </details>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={!key.trim()}
        onClick={() => {
          add([{ key: key.trim(), value, scope }]);
          setKey("");
          setValue("");
          setScope("runtime");
        }}
      >
        Add variable
      </Button>
      <details className="text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer">Paste multiple variables</summary>
        <div className="mt-2 space-y-2">
          <Textarea
            value={bulk}
            onChange={(event) => setBulk(event.target.value)}
            placeholder={"KEY=value\nANOTHER_KEY=value"}
            className="font-mono text-xs"
          />
          <ScopeControl scope={bulkScope} onChange={setBulkScope} />
          {bulkScope !== "runtime" && bulk.split(/\r?\n/).some((line) => looksSensitive(line.split("=")[0] ?? "")) ? (
            <p className="text-xs text-destructive">
              Some pasted keys look like credentials. Build access can expose them in the image.
            </p>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              const next: VariableEntry[] = [];
              for (const [index, line] of bulk.split(/\r?\n/).entries()) {
                if (!line.trim() || line.trim().startsWith("#")) continue;
                const separator = line.indexOf("=");
                if (separator < 1) {
                  toast.error(`Variable line ${index + 1} must use KEY=value`);
                  return;
                }
                next.push({
                  key: line.slice(0, separator).trim(),
                  value: line.slice(separator + 1),
                  scope: bulkScope
                });
              }
              if (next.length === 0) return;
              add(next);
              setBulk("");
              setBulkScope("runtime");
            }}
          >
            Add pasted variables
          </Button>
        </div>
      </details>
      <p className="text-xs text-muted-foreground">
        Build values may remain visible in image layers. Keep credentials at runtime unless the build needs them.
      </p>
    </div>
  );
}
