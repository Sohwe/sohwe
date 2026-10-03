import { forwardRef, useImperativeHandle, useState } from "react";
import { VariableEntrySchema, type VariableEntry, type VariableScope } from "@sohwe/types";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BuildAccess, ScopeSelect } from "./ScopedVariableInputs";
import { looksSecret, parseEnvText, SCOPE_HINT, SCOPE_LABEL } from "./scoped-variable-utils";

function addOrUpdate(current: VariableEntry[], incoming: VariableEntry[]): VariableEntry[] {
  const next = [...current];
  for (const entry of incoming) {
    const index = next.findIndex((item) => item.key === entry.key);
    if (index < 0) next.push(entry);
    else next[index] = entry;
  }
  return next;
}

export type InitialVariablesEditorHandle = {
  collect: () => { vars: VariableEntry[] } | { error: string };
};

export const InitialVariablesEditor = forwardRef<InitialVariablesEditorHandle, {
  value: VariableEntry[];
  onChange: (value: VariableEntry[]) => void;
  disabled: boolean;
  runtimeOnly?: boolean;
}>(function InitialVariablesEditor({
  value,
  onChange,
  disabled,
  runtimeOnly = false
}, ref) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newScope, setNewScope] = useState<VariableScope>("runtime");
  const [bulk, setBulk] = useState("");
  const [bulkScope, setBulkScope] = useState<VariableScope>("runtime");
  const [error, setError] = useState<string | null>(null);

  function collect(): { vars: VariableEntry[] } | { error: string } {
    let entries = value;
    if (newKey.trim() || newValue) {
      const entry = { key: newKey.trim(), value: newValue, scope: newScope };
      if (!VariableEntrySchema.safeParse(entry).success) {
        return { error: "Check the variable name and value before creating the app." };
      }
      entries = addOrUpdate(entries, [entry]);
    }
    if (bulk.trim()) {
      const lines = bulk.split(/\r?\n/).map((line) => line.trim());
      if (lines.some((line) => line && !line.startsWith("#") && !line.includes("="))) {
        return { error: "Each pasted line must use KEY=value." };
      }
      const parsed = Object.entries(parseEnvText(bulk)).map(([key, itemValue]) => ({ key, value: itemValue, scope: bulkScope }));
      if (parsed.length === 0 || parsed.some((entry) => !VariableEntrySchema.safeParse(entry).success)) {
        return { error: "Check pasted variable names and values before creating the app." };
      }
      entries = addOrUpdate(entries, parsed);
    }
    if (entries.length > 500 || entries.some((entry) => !VariableEntrySchema.safeParse(entry).success)) {
      return { error: "Up to 500 variables and 32 KB per value are allowed." };
    }
    if (runtimeOnly && entries.some((entry) => entry.scope !== "runtime")) return { error: "Image apps support runtime variables only." };
    return { vars: entries };
  }

  useImperativeHandle(ref, () => ({ collect }));

  function addOne() {
    const entry = { key: newKey.trim(), value: newValue, scope: newScope };
    if (!VariableEntrySchema.safeParse(entry).success || addOrUpdate(value, [entry]).length > 500) {
      setError("Use a valid variable name and value. Up to 500 keys and 32 KB per value are allowed.");
      return;
    }
    onChange(addOrUpdate(value, [entry]));
    setNewKey("");
    setNewValue("");
    setNewScope("runtime");
    setError(null);
  }

  function addBulk() {
    const lines = bulk.split(/\r?\n/).map((line) => line.trim());
    if (lines.some((line) => line && !line.startsWith("#") && !line.includes("="))) {
      setError("Each non-comment line must use KEY=value.");
      return;
    }
    const parsed = parseEnvText(bulk);
    const entries = Object.entries(parsed).map(([key, itemValue]) => ({ key, value: itemValue, scope: bulkScope }));
    if (entries.length === 0) {
      setError("Paste at least one KEY=value pair.");
      return;
    }
    if (entries.some((entry) => !VariableEntrySchema.safeParse(entry).success) || addOrUpdate(value, entries).length > 500) {
      setError("Check variable names and values. Up to 500 keys and 32 KB per value are allowed.");
      return;
    }
    onChange(addOrUpdate(value, entries));
    setBulk("");
    setBulkScope("runtime");
    setError(null);
  }

  return (
    <section className="space-y-3 rounded-lg border border-border/70 p-3">
      <div>
        <h3 className="text-sm font-medium">Variables for the first deploy</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Optional. Values are encrypted when the app is saved. Runtime only is the safest default.
        </p>
        {!runtimeOnly ? <p className="mt-1 text-xs text-muted-foreground">
          Build access can bake values into image layers. Keep credentials at runtime unless the build needs them.
        </p> : null}
      </div>
      {value.length > 0 ? (
        <div className="space-y-2">
          {value.map((entry) => (
            <div key={entry.key} className="grid gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-center">
              <span className="truncate font-mono text-xs" title={entry.key}>{entry.key}</span>
              <Input
                type="password"
                value={entry.value}
                aria-label={`Value for ${entry.key}`}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                className="font-mono text-xs"
                onChange={(event) => onChange(value.map((item) => item.key === entry.key ? { ...item, value: event.target.value } : item))}
              />
              <div className="flex items-center gap-2">
                {!runtimeOnly ? <ScopeSelect
                  value={entry.scope}
                  disabled={disabled}
                  onChange={(scope) => onChange(value.map((item) => item.key === entry.key ? { ...item, scope } : item))}
                /> : null}
                <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(value.filter((item) => item.key !== entry.key))}>
                  Remove
                </Button>
              </div>
              {entry.scope !== "runtime" && looksSecret(entry.key) ? (
                <p className="text-xs text-destructive sm:col-span-3">{entry.key} looks like a credential. Build access can expose its value in the image.</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Variable name">
          <Input
            value={newKey}
            onChange={(event) => setNewKey(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addOne();
              }
            }}
            placeholder="DATABASE_URL"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            className="font-mono text-sm"
          />
        </Field>
        <Field label="Value (can be empty)">
          <Input
            type="password"
            value={newValue}
            onChange={(event) => setNewValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addOne();
              }
            }}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            className="font-mono text-sm"
          />
        </Field>
        <div className="sm:col-span-2">
          {!runtimeOnly ? <><BuildAccess scope={newScope} onChange={setNewScope} disabled={disabled} />
          <p className="mt-1 text-xs text-muted-foreground">{SCOPE_HINT[newScope]}</p>
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer">Advanced scope options</summary>
            <div className="mt-2"><ScopeSelect value={newScope} onChange={setNewScope} disabled={disabled} /></div>
          </details></> : null}
        </div>
        {newScope !== "runtime" && looksSecret(newKey.trim()) ? (
          <p className="text-xs text-destructive sm:col-span-2">This name looks like a credential. Use Runtime only unless the build needs it.</p>
        ) : null}
        <Button type="button" variant="secondary" className="w-fit sm:col-span-2" disabled={disabled || !newKey.trim()} onClick={addOne}>
          Add variable
        </Button>
      </div>
      <details className="border-t border-border/70 pt-3">
        <summary className="cursor-pointer text-sm font-medium">Paste .env values</summary>
        <div className="mt-3 space-y-2">
          <Textarea
            value={bulk}
            onChange={(event) => setBulk(event.target.value)}
            placeholder={"# KEY=value\nNODE_ENV=production"}
            disabled={disabled}
            spellCheck={false}
            className="min-h-28 font-mono text-xs"
          />
          {!runtimeOnly ? <><BuildAccess scope={bulkScope} onChange={setBulkScope} disabled={disabled} />
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer">Advanced scope options</summary>
            <div className="mt-2"><ScopeSelect value={bulkScope} onChange={setBulkScope} disabled={disabled} /></div>
          </details></> : null}
          {bulkScope !== "runtime" && Object.keys(parseEnvText(bulk)).some(looksSecret) ? (
            <p className="text-xs text-destructive">Some pasted keys look like credentials. Build access can expose their values in the image.</p>
          ) : null}
          <Button type="button" variant="secondary" disabled={disabled || !bulk.trim()} onClick={addBulk}>
            Add pasted as {SCOPE_LABEL[bulkScope].toLowerCase()}
          </Button>
        </div>
      </details>
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
    </section>
  );
});
