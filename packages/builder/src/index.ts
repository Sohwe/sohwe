import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogHandler = (line: string) => void;

export type BuildMode = "auto" | "dockerfile" | "nixpacks";

export type BuildOptions = {
  contextDir: string;
  imageTag: string;
  /** How the user configured the app. "auto" inspects `contextDir` to pick. */
  mode: BuildMode;
  /** Optional build command override (nixpacks only). */
  buildCmd?: string | null;
  /** Optional start command override (nixpacks only). */
  startCmd?: string | null;
  onLogLine: LogHandler;
};

export type BuildResult = {
  imageTag: string;
  /** Which engine actually ran. */
  engine: "dockerfile" | "nixpacks";
};

export type DockerBuildOptions = {
  contextDir: string;
  imageTag: string;
  onLogLine: LogHandler;
};

export type NixpacksBuildOptions = {
  contextDir: string;
  imageTag: string;
  buildCmd?: string | null;
  startCmd?: string | null;
  onLogLine: LogHandler;
};

function hasDockerfile(dir: string): boolean {
  return existsSync(join(dir, "Dockerfile"));
}

function resolveToolCommand(cmd: string): string {
  if (cmd !== "nixpacks" || process.platform !== "win32") return cmd;

  const localNixpacks = join(homedir(), ".nixpacks", "bin", "nixpacks.exe");
  return existsSync(localNixpacks) ? localNixpacks : cmd;
}

/**
 * Spawn a process and forward stdout+stderr to `onLogLine`.
 * Resolves on exit 0; rejects with a helpful message otherwise.
 */
function runTool(
  cmd: string,
  args: string[],
  opts: { cwd?: string; onLogLine: LogHandler; tool: string }
): Promise<void> {
  const { cwd, onLogLine, tool } = opts;
  return new Promise((resolve, reject) => {
    const p = spawn(resolveToolCommand(cmd), args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const forward = (buf: Buffer) => {
      const s = buf.toString();
      for (const line of s.split(/\r?\n/)) {
        if (line) onLogLine(line);
      }
    };
    p.stdout?.on("data", forward);
    p.stderr?.on("data", forward);
    p.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `${tool} not found on PATH. Install it and retry: https://nixpacks.com/docs/install`
          )
        );
        return;
      }
      reject(e);
    });
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${tool} failed with exit code ${String(code)}`));
    });
  });
}

/**
 * Build a Docker image from a Dockerfile at `contextDir/Dockerfile`.
 * Streams stdout/stderr to `onLogLine`.
 */
export async function dockerBuild(opts: DockerBuildOptions): Promise<void> {
  const { contextDir, imageTag, onLogLine } = opts;
  if (!hasDockerfile(contextDir)) {
    throw new Error(
      "No Dockerfile in repository root. Switch build mode to auto/nixpacks or add a Dockerfile."
    );
  }
  await runTool("docker", ["build", "-t", imageTag, contextDir], {
    onLogLine,
    tool: "docker build"
  });
}

/**
 * Build an image with Nixpacks. Shells out to the `nixpacks` CLI —
 * there is no official Node SDK. Log output is forwarded live.
 *
 * Nixpacks auto-detects Node / Next.js / Python / Go / Rust / static sites.
 * `buildCmd` / `startCmd` let the user override detection when needed.
 */
export async function nixpacksBuild(opts: NixpacksBuildOptions): Promise<void> {
  const { contextDir, imageTag, buildCmd, startCmd, onLogLine } = opts;
  const args = ["build", contextDir, "--name", imageTag];
  if (buildCmd && buildCmd.trim()) {
    args.push("--build-cmd", buildCmd);
  }
  if (startCmd && startCmd.trim()) {
    args.push("--start-cmd", startCmd);
  }
  await runTool("nixpacks", args, { onLogLine, tool: "nixpacks build" });
}

/**
 * Pick a build engine based on `mode` and repo contents, then build.
 *
 * - `dockerfile`: require a Dockerfile, fail otherwise.
 * - `nixpacks`: always use Nixpacks.
 * - `auto`: Dockerfile wins if present, otherwise Nixpacks.
 */
export async function buildAppImage(opts: BuildOptions): Promise<BuildResult> {
  const { contextDir, imageTag, mode, buildCmd, startCmd, onLogLine } = opts;
  const hasDf = hasDockerfile(contextDir);

  const useDockerfile =
    mode === "dockerfile" || (mode === "auto" && hasDf);

  if (mode === "dockerfile" && !hasDf) {
    throw new Error(
      "Build mode is set to 'dockerfile' but no Dockerfile was found at the repo root."
    );
  }

  if (useDockerfile) {
    onLogLine(`[sohwe] Engine: docker build (Dockerfile detected)`);
    if (buildCmd || startCmd) {
      onLogLine(
        `[sohwe] Note: build-cmd/start-cmd overrides are ignored in Dockerfile mode.`
      );
    }
    await dockerBuild({ contextDir, imageTag, onLogLine });
    return { imageTag, engine: "dockerfile" };
  }

  onLogLine(
    `[sohwe] Engine: nixpacks${
      mode === "auto" ? " (no Dockerfile found; auto-detecting runtime)" : ""
    }`
  );
  await nixpacksBuild({
    contextDir,
    imageTag,
    buildCmd,
    startCmd,
    onLogLine
  });
  return { imageTag, engine: "nixpacks" };
}
