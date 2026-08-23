import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildArgs } from "./index";

// Nixpacks' Node provider resolves a version from, in order:
//   1. NIXPACKS_NODE_VERSION in the build environment
//   2. `engines.node` in package.json
//   3. .nvmrc
//   4. .node-version
//   5. DEFAULT_NODE_VERSION, which is 18
//
// Step 5 is the problem. Node 18 reached end of life in April 2025, and current
// Next.js, Vite, and Tailwind all refuse to build on it, so a repo that pins
// nothing gets a confusing failure at `npm run build` rather than anything
// pointing at the runtime. Sohwe fills in a supported LTS for exactly that case
// and leaves every repo that expressed a preference alone.

/** Injected only when the repo pins nothing. In Nixpacks' supported set. */
export const DEFAULT_NODE_VERSION = "22";

export const NODE_VERSION_KEY = "NIXPACKS_NODE_VERSION";

export type NodeVersionResolution =
  /** Nothing injected; `reason` says who already decided. */
  | { applied: false; reason: "explicit" | "repo-pinned" | "not-node" }
  /** Sohwe supplied the version because nothing else did. */
  | { applied: true; version: string };

/**
 * A version string only counts as a pin if it actually constrains something.
 * Nixpacks itself treats `"*"` as unspecified and falls back to 18, so an
 * `engines.node` of `"*"` must not stop us from filling in a default.
 */
function isMeaningfulPin(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "*";
}

/** Read a file, returning undefined if it is absent or unreadable. */
function tryRead(dir: string, name: string): string | undefined {
  try {
    return readFileSync(join(dir, name), "utf8");
  } catch {
    return undefined;
  }
}

function enginesNode(contextDir: string): string | undefined {
  const raw = tryRead(contextDir, "package.json");
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const engines = (parsed as { engines?: unknown }).engines;
    if (!engines || typeof engines !== "object" || Array.isArray(engines)) {
      return undefined;
    }
    const node = (engines as { node?: unknown }).node;
    return typeof node === "string" ? node : undefined;
  } catch {
    // A malformed package.json is Nixpacks' problem to report, not ours. Treat
    // it as expressing no preference so the build still gets a usable runtime.
    return undefined;
  }
}

/**
 * Decide whether Sohwe should supply a Node version for a Nixpacks build.
 *
 * Only for Nixpacks: a Dockerfile build picks its own base image, where
 * `NIXPACKS_NODE_VERSION` means nothing.
 */
export function resolveNodeVersion(
  contextDir: string,
  buildArgs?: BuildArgs | null
): NodeVersionResolution {
  if (isMeaningfulPin(buildArgs?.[NODE_VERSION_KEY])) {
    return { applied: false, reason: "explicit" };
  }

  // No package.json means no Node project, so Nixpacks will pick some other
  // provider entirely and a Node version would be noise.
  if (tryRead(contextDir, "package.json") === undefined) {
    return { applied: false, reason: "not-node" };
  }

  if (isMeaningfulPin(enginesNode(contextDir))) {
    return { applied: false, reason: "repo-pinned" };
  }
  for (const file of [".nvmrc", ".node-version"]) {
    if (isMeaningfulPin(tryRead(contextDir, file))) {
      return { applied: false, reason: "repo-pinned" };
    }
  }

  return { applied: true, version: DEFAULT_NODE_VERSION };
}
