import { VariableEditor } from "@/components/apps/VariableEditor";

/**
 * Build variables — passed to `nixpacks build --env` / `docker build
 * --build-arg`. This is the only place a value can influence the build itself:
 * runtime environment variables are injected long after the image exists.
 */
export function BuildArgsManager({ appId, onChanged }: { appId: string; onChanged: () => void }) {
  return (
    <VariableEditor
      appId={appId}
      resource="build-args"
      title="Build variables"
      description="Available while the image is built, not at runtime. Use these to pin a toolchain (NIXPACKS_NODE_VERSION), reach a private registry, or set values a framework inlines at build time."
      keyPlaceholder="NIXPACKS_NODE_VERSION"
      bulkPlaceholder="# KEY=value&#10;NIXPACKS_NODE_VERSION=22"
      noun="build variable"
      callout={
        <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Encrypted at rest, but build variables end up in the built image and are
          readable via <span className="font-mono">docker history</span>. Keep
          runtime secrets in environment variables instead. A Dockerfile build
          only sees a variable it declares with a matching{" "}
          <span className="font-mono">ARG</span>.
        </p>
      }
      onChanged={onChanged}
    />
  );
}
