import { VariableEditor } from "@/components/apps/VariableEditor";

/** Runtime environment variables — injected into the container, never the build. */
export function EnvManager({ appId, onChanged }: { appId: string; onChanged: () => void }) {
  return (
    <VariableEditor
      appId={appId}
      resource="env"
      title="Environment variables"
      description="Encrypted at rest. Values are only injected at deploy time. Redeploy after changes to apply in the running container."
      keyPlaceholder="PORT"
      bulkPlaceholder="# KEY=value&#10;NODE_ENV=production"
      noun="variable"
      onChanged={onChanged}
    />
  );
}
