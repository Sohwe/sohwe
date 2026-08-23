import { type ReactNode, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";

// An application has two independent KEY=value maps behind identical APIs:
// runtime env vars (`/env`) and build variables (`/build-args`). This is the
// shared editor for both; the wrappers supply the endpoint and the wording.

type VarListMasked = { keys: string[]; items: { key: string; preview: string }[] };
type VarListReveal = { keys: string[]; items: { key: string; value: string }[] };

export type VariableEditorProps = {
  appId: string;
  /** Path segment under `/api/applications/:id/`. */
  resource: "env" | "build-args";
  title: string;
  description: ReactNode;
  /** Placeholder key in the add form, e.g. `PORT` or `NIXPACKS_NODE_VERSION`. */
  keyPlaceholder: string;
  /** Placeholder for the bulk paste box. */
  bulkPlaceholder: string;
  /** Wording for the empty state and the remove confirmation. */
  noun: string;
  /** Optional callout rendered above the list. */
  callout?: ReactNode;
  onChanged: () => void;
};

function parseEnvText(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).replace(/^['"]|['"]$/g, "").trim();
    if (k) out[k] = v;
  }
  return out;
}

export function VariableEditor({
  appId,
  resource,
  title,
  description,
  keyPlaceholder,
  bulkPlaceholder,
  noun,
  callout,
  onChanged
}: VariableEditorProps) {
  const queryClient = useQueryClient();
  const path = `/api/applications/${appId}/${resource}`;
  const queryKey = [`app-${resource}`, appId];

  const listQuery = useQuery({
    queryKey,
    queryFn: () => apiGet<VarListMasked>(path)
  });
  const [unlocked, setUnlocked] = useState<Record<string, string> | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [removeKey, setRemoveKey] = useState<string | null>(null);
  const [bulk, setBulk] = useState("");

  const putMut = useMutation({
    mutationFn: (vars: Record<string, string>) =>
      api(path, { method: "PUT", body: JSON.stringify({ vars }) }),
    onSuccess: () => {
      setUnlocked(null);
      setBulk("");
      void queryClient.invalidateQueries({ queryKey });
      onChanged();
      toast.success(`${title} saved`);
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    }
  });

  const patchMut = useMutation({
    mutationFn: (body: { set?: Record<string, string>; unset?: string[] }) =>
      api(path, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      onChanged();
      toast.success("Updated");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {callout}
          {listQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {listQuery.isError ? <p className="text-sm text-destructive">Could not load {noun} list.</p> : null}
          {unlocked == null && listQuery.data ? (
            <ul className="space-y-2">
              {listQuery.data.items.length === 0 ? (
                <li className="text-sm text-muted-foreground">No {noun}s yet.</li>
              ) : null}
              {listQuery.data.items.map((row) => (
                <li key={row.key} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-mono text-foreground">{row.key}</span>
                    <span className="ml-2 text-muted-foreground">{row.preview}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setRemoveKey(row.key)}>
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {unlocked != null ? (
            <div className="space-y-2">
              {Object.keys(unlocked).map((k) => (
                <div key={k} className="grid gap-2 sm:grid-cols-[1fr_2fr] sm:items-center">
                  <Input className="font-mono text-xs" value={k} readOnly disabled title="Remove and re-add to rename" />
                  <Input
                    className="font-mono text-xs"
                    value={unlocked[k] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setUnlocked((prev) => (prev ? { ...prev, [k]: v } : { [k]: v }));
                    }}
                  />
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={putMut.isPending} onClick={() => unlocked && void putMut.mutateAsync(unlocked)}>
                  {putMut.isPending ? "Saving…" : "Save all"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setUnlocked(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          {unlocked == null ? (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2 sm:items-end">
                <Field label="New key">
                  <Input
                    className="font-mono text-sm"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value.toUpperCase())}
                    placeholder={keyPlaceholder}
                    spellCheck={false}
                  />
                </Field>
                <Field label="Value">
                  <Input
                    className="font-mono text-sm"
                    value={newVal}
                    onChange={(e) => setNewVal(e.target.value)}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Button
                  type="button"
                  className="sm:col-span-2 w-fit"
                  variant="secondary"
                  disabled={patchMut.isPending || !newKey.trim() || !newVal}
                  onClick={() => {
                    const k = newKey.trim();
                    if (!k) return;
                    patchMut.mutate(
                      { set: { [k]: newVal } },
                      { onSuccess: () => { setNewKey(""); setNewVal(""); } }
                    );
                  }}
                >
                  Add {noun}
                </Button>
              </div>
              {unlocked == null && listQuery.data != null && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0"
                    onClick={async () => {
                      const r = await apiGet<VarListReveal>(`${path}?reveal=true`);
                      setUnlocked(Object.fromEntries(r.items.map((x) => [x.key, x.value])));
                    }}
                  >
                    Show / edit all values…
                  </Button>
                </div>
              )}
              <div>
                <Field label="Bulk paste .env (replaces on save)">
                  <Textarea
                    className="min-h-28 font-mono text-xs"
                    placeholder={bulkPlaceholder}
                    value={bulk}
                    onChange={(e) => setBulk(e.target.value)}
                    spellCheck={false}
                  />
                </Field>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={putMut.isPending}
                    onClick={() => {
                      if (!bulk.trim()) {
                        toast.error("Paste a .env first");
                        return;
                      }
                      const vars = parseEnvText(bulk);
                      if (!Object.keys(vars).length) {
                        toast.error("No KEY=value pairs found");
                        return;
                      }
                      void putMut.mutateAsync(vars);
                    }}
                  >
                    Save &amp; replace from paste
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={removeKey != null}
        onOpenChange={(o) => !o && setRemoveKey(null)}
        title={`Remove ${noun}`}
        description={`Remove ${removeKey ?? ""} from this application? This cannot be undone from the UI alone.`}
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={() => {
          if (removeKey) patchMut.mutate({ unset: [removeKey] });
          setRemoveKey(null);
        }}
      />
    </div>
  );
}
