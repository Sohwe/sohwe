import type { VariableScope } from "@sohwe/types";

export const SCOPE_LABEL: Record<VariableScope, string> = {
  both: "Build + runtime",
  runtime: "Runtime only",
  build: "Build only"
};

export const SCOPE_HINT: Record<VariableScope, string> = {
  both: "Reaches the image build and the running container.",
  runtime: "Injected into the container at deploy time. Never reaches the image.",
  build: "Passed to the build only. Not present at runtime."
};

/** Warn before a likely credential is exposed to an image build. */
const SECRETISH = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|DATABASE_URL|REDIS_URL|_DSN)/;
const PUBLICISH = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_)/;

export function looksSecret(key: string): boolean {
  const normalized = key.toUpperCase();
  return SECRETISH.test(normalized) && !PUBLICISH.test(normalized);
}

export function parseEnvText(raw: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
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
