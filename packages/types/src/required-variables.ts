import type { SohweConfig } from "./config";

export function missingRequiredVariables(config: SohweConfig, env: Record<string, string>, build: Record<string, string>): string[] {
  return (config.application.variables ?? []).filter(({ key, scope, required }) =>
    required && ((scope === "runtime" || scope === "both") && !env[key] || (scope === "build" || scope === "both") && !build[key])
  ).map(({ key }) => key);
}
