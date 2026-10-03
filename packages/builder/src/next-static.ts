import { existsSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";

const NEXT_CONFIG_FILES = ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"];

/** Recognize a literal Next.js static export without executing repository code. */
export function detectNextStaticExport(
  sourceDir: string,
  appDir: string,
  startCmd?: string | null
): string | null {
  const command = startCmd?.trim() ?? "";
  if (command && !/^(?:(?:npm|pnpm|yarn|bun)(?: run)? start|(?:npx )?next start)$/.test(command)) {
    return null;
  }

  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return null;
  }
  if (!pkg.dependencies?.next && !pkg.devDependencies?.next) return null;
  const script = pkg.scripts?.start?.trim();
  if (script && !/^(?:npx\s+)?next\s+start(?:\s|$)/.test(script) && !command.startsWith("next start")) {
    return null;
  }

  const configPath = NEXT_CONFIG_FILES.map((name) => join(appDir, name)).find(existsSync);
  if (!configPath) return null;
  const config = readFileSync(configPath, "utf8");
  if (!/\boutput\s*:\s*["']export["']/.test(config)) return null;

  const customDir = /\bdistDir\s*:\s*["']([^"']+)["']/.exec(config)?.[1];
  const outputDir = customDir ?? "out";
  if (outputDir === "." || outputDir.split(/[\\/]/).includes("..") || !/^[A-Za-z0-9._/-]+$/.test(outputDir)) {
    return null;
  }
  const fromSource = relative(resolve(sourceDir), resolve(appDir));
  if (fromSource === ".." || fromSource.startsWith(`..${sep}`)) return null;
  return [fromSource, outputDir].filter(Boolean).join("/").replaceAll("\\", "/");
}

/** Include a small HTTP server in the built image without changing the user's dependencies. */
export function nextStaticServerSource(outputDir: string, port: number, imageRoot = "/app"): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Static site port must be between 1 and 65535.");
  }
  const root = imageRoot === "/app" ? posix.join(imageRoot, outputDir) : join(imageRoot, outputDir);
  const body = readFileSync(new URL("../assets/static-server.cjs", import.meta.url), "utf8");
  return `const SOHWE_STATIC_ROOT = ${JSON.stringify(root)};\nconst SOHWE_STATIC_PORT = ${port};\n${body}`;
}
