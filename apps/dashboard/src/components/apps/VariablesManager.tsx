import { useState } from "react";
import type { VariableScope } from "@sohwe/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Notice, ResourceItem, ResourceList } from "@/components/common/Section";
import { BuildAccess, ScopeSelect } from "./ScopedVariableInputs";
import { looksSecret, parseEnvText, SCOPE_HINT, SCOPE_LABEL } from "./scoped-variable-utils";

/**
 * One list per application, each variable scoped to the build, the container,
 * or both — so a value needed in both places is typed once. The scope is
 * derived server-side from the two encrypted maps; this component only ever
 * talks in scopes.
 */

type Scope = VariableScope;

type MaskedItem = {
  key: string;
  scope: Scope;
  preview: string;
  conflict?: boolean;
  buildPreview?: string;
};
type RevealItem = {
  key: string;
  scope: Scope;
  value: string;
  conflict?: boolean;
  buildValue?: string;
};

export function VariablesManager({ path, onChanged }: { path: string; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const queryKey = ["scoped-variables", path];

  const listQuery = useQuery({
    queryKey,
    queryFn: () => apiGet<{ items: MaskedItem[] }>(path)
  });

  const [unlocked, setUnlocked] = useState<RevealItem[] | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [newScope, setNewScope] = useState<Scope>("runtime");
  const [removeKey, setRemoveKey] = useState<string | null>(null);
  const [bulk, setBulk] = useState("");
  const [bulkScope, setBulkScope] = useState<Scope>("runtime");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey });
    onChanged();
  };

  const putMut = useMutation({
    mutationFn: (vars: { key: string; value: string; scope: Scope }[]) =>
      api(path, { method: "PUT", body: JSON.stringify({ vars }) }),
    onSuccess: () => {
      setUnlocked(null);
      invalidate();
      toast.success("Variables saved");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to save")
  });

  const patchMut = useMutation({
    mutationFn: (body: {
      set?: { key: string; value: string; scope: Scope }[];
      rescope?: { key: string; scope: Scope }[];
      unset?: string[];
    }) => api(path, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      invalidate();
      toast.success("Updated");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Update failed")
  });

  const items = listQuery.data?.items ?? [];
  const newKeyWarn = looksSecret(newKey.trim()) && newScope !== "runtime";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Variables</CardTitle>
          <CardDescription>
            Encrypted at rest. Variables are available to the running container by default. Enable build access only
            when the build needs a value. Redeploy to apply changes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Notice className="text-xs">
            Anything reaching the build is baked into image layers and readable via{" "}
            <span className="font-mono">docker history</span>. Keep credentials on{" "}
            <span className="font-mono">Runtime only</span>. A Dockerfile build additionally only sees a variable it
            declares with a matching <span className="font-mono">ARG</span>.
          </Notice>

          {listQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {listQuery.isError ? <p className="text-sm text-destructive">Could not load variables.</p> : null}

          {unlocked == null && listQuery.data ? (
            <ResourceList>
              {items.length === 0 ? <li className="text-sm text-muted-foreground">No variables yet.</li> : null}
              {items.map((row) => (
                <ResourceItem key={row.key} className="text-sm">
                  <div className="min-w-0">
                    <span className="font-mono text-foreground">{row.key}</span>
                    <span className="ml-2 text-muted-foreground">
                      {row.preview === "—" ? "(empty)" : row.preview}
                    </span>
                    {row.conflict ? (
                      <span className="ml-2 text-xs text-destructive">
                        build holds a different value ({row.buildPreview}) — save this key to reconcile
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <BuildAccess
                      scope={row.scope}
                      variableKey={row.key}
                      disabled={patchMut.isPending}
                      onChange={(scope) => {
                        if (scope === row.scope) return;
                        patchMut.mutate({ rescope: [{ key: row.key, scope }] });
                      }}
                    />
                    <Button type="button" size="sm" variant="ghost" onClick={() => setRemoveKey(row.key)}>
                      Remove
                    </Button>
                  </div>
                </ResourceItem>
              ))}
            </ResourceList>
          ) : null}

          {unlocked != null ? (
            <div className="space-y-2">
              {unlocked.map((row, i) => (
                <div key={row.key} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-center">
                  <Input className="font-mono text-xs" value={row.key} readOnly disabled title="Remove and re-add to rename" />
                  <Input
                    className="font-mono text-xs"
                    value={row.value}
                    placeholder="Empty value"
                    onChange={(e) => {
                      const value = e.target.value;
                      setUnlocked((prev) => prev?.map((r, j) => (j === i ? { ...r, value } : r)) ?? prev);
                    }}
                  />
                  <ScopeSelect
                    value={row.scope}
                    onChange={(scope) =>
                      setUnlocked((prev) => prev?.map((r, j) => (j === i ? { ...r, scope } : r)) ?? prev)
                    }
                  />
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={putMut.isPending}
                  onClick={() =>
                    unlocked &&
                    void putMut.mutateAsync(
                      unlocked.map((r) => ({ key: r.key, value: r.value, scope: r.scope }))
                    )
                  }
                >
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
                    placeholder="NEXT_PUBLIC_API_URL"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Value (can be empty)">
                  <Input
                    className="font-mono text-sm"
                    value={newVal}
                    onChange={(e) => setNewVal(e.target.value)}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <BuildAccess scope={newScope} onChange={setNewScope} />
                  <p className="mt-1 text-xs text-muted-foreground">{SCOPE_HINT[newScope]}</p>
                </div>
                <details className="text-xs text-muted-foreground sm:col-span-2">
                  <summary className="w-fit cursor-pointer">Advanced scope options</summary>
                  <div className="mt-2"><ScopeSelect value={newScope} onChange={setNewScope} /></div>
                </details>
                {newKeyWarn ? (
                  <p className="text-xs text-destructive sm:col-span-2">
                    {newKey.trim()} looks like a credential. Use{" "}
                    <button type="button" className="underline" onClick={() => setNewScope("runtime")}>
                      Runtime only
                    </button>{" "}
                    unless the build genuinely needs it — build values can end up in the image.
                  </p>
                ) : null}
                <Button
                  type="button"
                  className="sm:col-span-2 w-fit"
                  variant="secondary"
                  disabled={patchMut.isPending || !newKey.trim()}
                  onClick={() => {
                    const key = newKey.trim();
                    if (!key) return;
                    patchMut.mutate(
                      { set: [{ key, value: newVal, scope: newScope }] },
                      {
                        onSuccess: () => {
                          setNewKey("");
                          setNewVal("");
                          setNewScope("runtime");
                        }
                      }
                    );
                  }}
                >
                  Add variable
                </Button>
              </div>

              {listQuery.data != null ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0"
                    onClick={async () => {
                      const r = await apiGet<{ items: RevealItem[] }>(`${path}?reveal=true`);
                      setUnlocked(r.items.map((x) => ({ ...x })));
                    }}
                  >
                    Show / edit all values…
                  </Button>
                </div>
              ) : null}

              <div>
                <Field label="Bulk paste .env (adds and updates; existing keys keep their place)">
                  <Textarea
                    className="min-h-28 font-mono text-xs"
                    placeholder="# KEY=value&#10;NODE_ENV=production"
                    value={bulk}
                    onChange={(e) => setBulk(e.target.value)}
                    spellCheck={false}
                  />
                </Field>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <BuildAccess scope={bulkScope} onChange={setBulkScope} />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={patchMut.isPending}
                    onClick={() => {
                      if (!bulk.trim()) {
                        toast.error("Paste a .env first");
                        return;
                      }
                      const parsed = parseEnvText(bulk);
                      const keys = Object.keys(parsed);
                      if (!keys.length) {
                        toast.error("No KEY=value pairs found");
                        return;
                      }
                      patchMut.mutate(
                        { set: keys.map((key) => ({ key, value: parsed[key] ?? "", scope: bulkScope })) },
                        {
                          onSuccess: () => {
                            setBulk("");
                            setBulkScope("runtime");
                          }
                        }
                      );
                    }}
                  >
                    Add {Object.keys(parseEnvText(bulk)).length || ""} pasted as {SCOPE_LABEL[bulkScope].toLowerCase()}
                  </Button>
                </div>
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="w-fit cursor-pointer">Advanced scope options</summary>
                  <div className="mt-2"><ScopeSelect value={bulkScope} onChange={setBulkScope} /></div>
                </details>
                {bulkScope !== "runtime" && Object.keys(parseEnvText(bulk)).some(looksSecret) ? (
                  <p className="mt-2 text-xs text-destructive">
                    Some pasted keys look like credentials. Build access can expose their values in the image.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={removeKey != null}
        onOpenChange={(o) => !o && setRemoveKey(null)}
        title="Remove variable"
        description={`Remove ${removeKey ?? ""} from this application? It is removed from both the build and the runtime. This cannot be undone from the UI alone.`}
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
