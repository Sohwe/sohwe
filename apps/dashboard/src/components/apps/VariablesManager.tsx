import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";

/**
 * One list per application, each variable scoped to the build, the container,
 * or both — so a value needed in both places is typed once. The scope is
 * derived server-side from the two encrypted maps; this component only ever
 * talks in scopes.
 */

type Scope = "runtime" | "build" | "both";

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

const SCOPE_LABEL: Record<Scope, string> = {
  both: "Build + runtime",
  runtime: "Runtime only",
  build: "Build only"
};

const SCOPE_HINT: Record<Scope, string> = {
  both: "Reaches the image build and the running container.",
  runtime: "Injected into the container at deploy time. Never reaches the image.",
  build: "Passed to the build only. Not present at runtime."
};

/**
 * Keys that usually hold a credential. Only a nudge — the user decides — but
 * "build + runtime" bakes a value into the image, and a leaked token is not a
 * mistake worth making silently.
 */
const SECRETISH = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|DATABASE_URL|REDIS_URL|_DSN)/;
const PUBLICISH = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_)/;

function looksSecret(key: string): boolean {
  return SECRETISH.test(key) && !PUBLICISH.test(key);
}

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

function ScopeSelect({
  value,
  onChange,
  disabled,
  className
}: {
  value: Scope;
  onChange: (s: Scope) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Scope)} disabled={disabled}>
      <SelectTrigger className={className ?? "h-8 w-[9.5rem] text-xs"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(["both", "runtime", "build"] as const).map((s) => (
          <SelectItem key={s} value={s}>
            {SCOPE_LABEL[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function VariablesManager({ appId, onChanged }: { appId: string; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const path = `/api/applications/${appId}/variables`;
  const queryKey = ["app-variables", appId];

  const listQuery = useQuery({
    queryKey,
    queryFn: () => apiGet<{ items: MaskedItem[] }>(path)
  });

  const [unlocked, setUnlocked] = useState<RevealItem[] | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [newScope, setNewScope] = useState<Scope>("both");
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
            Encrypted at rest. Each variable reaches the image build, the running container, or both — set it once and
            pick where it applies. Redeploy to apply changes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Anything reaching the build is baked into image layers and readable via{" "}
            <span className="font-mono">docker history</span>. Keep credentials on{" "}
            <span className="font-mono">Runtime only</span>. A Dockerfile build additionally only sees a variable it
            declares with a matching <span className="font-mono">ARG</span>.
          </p>

          {listQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {listQuery.isError ? <p className="text-sm text-destructive">Could not load variables.</p> : null}

          {unlocked == null && listQuery.data ? (
            <ul className="space-y-2">
              {items.length === 0 ? <li className="text-sm text-muted-foreground">No variables yet.</li> : null}
              {items.map((row) => (
                <li
                  key={row.key}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-foreground">{row.key}</span>
                    <span className="ml-2 text-muted-foreground">{row.preview}</span>
                    {row.conflict ? (
                      <span className="ml-2 text-xs text-destructive">
                        build holds a different value ({row.buildPreview}) — save this key to reconcile
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <ScopeSelect
                      value={row.scope}
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
                </li>
              ))}
            </ul>
          ) : null}

          {unlocked != null ? (
            <div className="space-y-2">
              {unlocked.map((row, i) => (
                <div key={row.key} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-center">
                  <Input className="font-mono text-xs" value={row.key} readOnly disabled title="Remove and re-add to rename" />
                  <Input
                    className="font-mono text-xs"
                    value={row.value}
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
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Field label="New key">
                  <Input
                    className="font-mono text-sm"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value.toUpperCase())}
                    placeholder="NEXT_PUBLIC_API_URL"
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
                <Field label="Applies to">
                  <ScopeSelect value={newScope} onChange={setNewScope} className="h-9 w-[9.5rem] text-xs" />
                </Field>
                <p className="text-xs text-muted-foreground sm:col-span-3">{SCOPE_HINT[newScope]}</p>
                {newKeyWarn ? (
                  <p className="text-xs text-destructive sm:col-span-3">
                    {newKey.trim()} looks like a credential. Use{" "}
                    <button type="button" className="underline" onClick={() => setNewScope("runtime")}>
                      Runtime only
                    </button>{" "}
                    unless the build genuinely needs it — build values end up in the image.
                  </p>
                ) : null}
                <Button
                  type="button"
                  className="sm:col-span-3 w-fit"
                  variant="secondary"
                  disabled={patchMut.isPending || !newKey.trim() || !newVal}
                  onClick={() => {
                    const key = newKey.trim();
                    if (!key) return;
                    patchMut.mutate(
                      { set: [{ key, value: newVal, scope: newScope }] },
                      {
                        onSuccess: () => {
                          setNewKey("");
                          setNewVal("");
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
                  <ScopeSelect value={bulkScope} onChange={setBulkScope} />
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
                        { onSuccess: () => setBulk("") }
                      );
                    }}
                  >
                    Add {Object.keys(parseEnvText(bulk)).length || ""} pasted as {SCOPE_LABEL[bulkScope].toLowerCase()}
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
