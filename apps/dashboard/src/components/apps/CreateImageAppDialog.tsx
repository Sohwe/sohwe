import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CreateApplicationSchema, type VariableEntry } from "@sohwe/types";
import { toast } from "sonner";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { AppRow } from "@/lib/types";
import { InitialVariablesEditor, type InitialVariablesEditorHandle } from "./InitialVariablesEditor";

function imageName(reference: string): string {
  return reference.split("/").pop()?.split(/[:@]/)[0] ?? "";
}

export function CreateImageAppDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const variablesEditor = useRef<InitialVariablesEditorHandle>(null);
  const [imageRef, setImageRef] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [port, setPort] = useState(80);
  const [runtimeCmd, setRuntimeCmd] = useState("");
  const [variables, setVariables] = useState<VariableEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedApp, setSavedApp] = useState<AppRow | null>(null);

  const deploy = useMutation({
    mutationFn: (app: AppRow) => api<{ deployment: { id: string } }>(`/api/applications/${app.id}/deploy`, { method: "POST" }),
    onSuccess: (result, app) => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      onOpenChange(false);
      toast.success("Image deploy started");
      void navigate({ to: "/apps/$appId/deployments/$deploymentId", params: { appId: app.id, deploymentId: result.deployment.id } });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not start deployment")
  });
  const create = useMutation({
    mutationFn: async ({ intent, entries }: { intent: "deploy" | "save"; entries: VariableEntry[] }) => {
      const body = CreateApplicationSchema.parse({ name, slug, imageRef, port, runtimeCmd: runtimeCmd || undefined, variables: entries, buildMode: "image" });
      const app = await api<AppRow>("/api/applications", { method: "POST", body: JSON.stringify(body) });
      return { app, intent };
    },
    onSuccess: ({ app, intent }) => {
      setSavedApp(app);
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      if (intent === "deploy") deploy.mutate(app);
      else {
        onOpenChange(false);
        toast.success("Image application saved for later");
      }
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not create image application")
  });
  const pending = create.isPending || deploy.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import a container image</DialogTitle>
          <DialogDescription>Deploy a public image from a registry. Confirm its listening port and enter runtime variables before starting.</DialogDescription>
        </DialogHeader>
        {savedApp ? (
          <div className="space-y-3 text-sm">
            <p><strong>{savedApp.name}</strong> was saved. Retrying deployment will use this app.</p>
            {error ? <p className="text-destructive" role="alert">{error}</p> : null}
            <div className="flex gap-2">
              <Button type="button" disabled={pending} onClick={() => { setError(null); deploy.mutate(savedApp); }}>Retry deploy</Button>
              <Button type="button" variant="outline" onClick={() => { onOpenChange(false); void navigate({ to: "/apps/$appId/overview", params: { appId: savedApp.id } }); }}>Open saved app</Button>
            </div>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={(event) => {
            event.preventDefault();
            const collected = variablesEditor.current?.collect() ?? { vars: variables };
            if ("error" in collected) { setError(collected.error); return; }
            setError(null);
            const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            create.mutate({ intent: submitter?.value === "save" ? "save" : "deploy", entries: collected.vars });
          }}>
            <Field label="Public image reference">
              <Input value={imageRef} onChange={(event) => {
                const next = event.target.value.trim();
                setImageRef(next);
                const suggested = imageName(next);
                if (!nameEdited) setName(suggested);
                if (!slugEdited) setSlug(suggested.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""));
              }} placeholder="ghcr.io/acme/web:1.0.0" required spellCheck={false} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name"><Input value={name} onChange={(event) => { setNameEdited(true); setName(event.target.value); }} required /></Field>
              <Field label="Slug (subdomain)"><Input value={slug} onChange={(event) => { setSlugEdited(true); setSlug(event.target.value.toLowerCase()); }} pattern="[a-z0-9-]+" required /></Field>
              <Field label="Container port"><Input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} required /></Field>
              <Field label="Command override (optional)"><Input value={runtimeCmd} onChange={(event) => setRuntimeCmd(event.target.value)} placeholder="Use image CMD by default" /></Field>
            </div>
            <InitialVariablesEditor ref={variablesEditor} value={variables} onChange={setVariables} disabled={pending} runtimeOnly />
            {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="submit" value="deploy" disabled={pending}>{create.isPending ? "Creating…" : "Create and deploy"}</Button>
              <Button type="submit" value="save" variant="outline" disabled={pending}>Save for later</Button>
              <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
