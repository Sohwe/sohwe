import type { VariableEntry } from "@sohwe/types";

export function splitServiceVariables(entries: readonly VariableEntry[]) {
  const envVars: Record<string, string> = {};
  const buildArgs: Record<string, string> = {};
  for (const { key, value, scope } of entries) {
    if (scope !== "build") envVars[key] = value;
    if (scope !== "runtime") buildArgs[key] = value;
  }
  return { envVars, buildArgs };
}
