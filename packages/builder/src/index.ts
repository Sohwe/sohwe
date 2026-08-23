import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NODE_VERSION_KEY, resolveNodeVersion } from "./node-version";

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
  /** Variables exposed to the build itself. See {@link BuildArgs}. */
  buildArgs?: BuildArgs | null;
  onLogLine: LogHandler;
};

/**
 * Variables the build sees, as `KEY -> value`.
 *
 * These are *not* runtime env vars. Nixpacks reads them during its setup phase
 * (which is how `NIXPACKS_NODE_VERSION` pins a toolchain — by the time
 * `buildCmd` runs the runtime is already chosen), and Dockerfile builds receive
 * them as `--build-arg`, matching declared `ARG` instructions.
 *
 * They end up in image layers and `docker history`, so the caller must treat
 * them as image-visible. Values are still kept off the command line where the
 * tool allows it, and scrubbed from forwarded log output either way.
 */
export type BuildArgs = Record<string, string>;

export type BuildResult = {
  imageTag: string;
  /** Which engine actually ran. */
  engine: "dockerfile" | "nixpacks";
};

export type DockerBuildOptions = {
  contextDir: string;
  imageTag: string;
  buildArgs?: BuildArgs | null;
  onLogLine: LogHandler;
};

export type NixpacksBuildOptions = {
  contextDir: string;
  imageTag: string;
  buildCmd?: string | null;
  startCmd?: string | null;
  buildArgs?: BuildArgs | null;
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

/** Values short enough to collide with ordinary log text are not worth masking. */
const MIN_REDACTABLE_LEN = 4;

/**
 * Replace every occurrence of a build variable's value with `***`.
 *
 * Neither tool prints these deliberately, but both echo fragments of the build
 * on failure (a Dockerfile line, a failing shell command), and build logs are
 * stored and streamed to the dashboard. Cheap insurance, same idea as
 * `redactSecret` on the Git side.
 */
export function redactValues(line: string, secrets?: readonly string[]): string {
  if (!secrets?.length) return line;
  let out = line;
  for (const secret of secrets) {
    if (secret.length < MIN_REDACTABLE_LEN) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * Spawn a process and forward stdout+stderr to `onLogLine`.
 * Resolves on exit 0; rejects with a helpful message otherwise.
 */
function runTool(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    onLogLine: LogHandler;
    tool: string;
    /** Extra variables for the child process environment. */
    env?: BuildArgs | null;
    /** Values scrubbed from forwarded output; see {@link redactValues}. */
    secrets?: readonly string[];
  }
): Promise<void> {
  const { cwd, onLogLine, tool, env, secrets } = opts;
  return new Promise((resolve, reject) => {
    const p = spawn(resolveToolCommand(cmd), args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: env && Object.keys(env).length > 0 ? { ...process.env, ...env } : undefined
    });
    const forward = (buf: Buffer) => {
      const s = buf.toString();
      for (const line of s.split(/\r?\n/)) {
        if (line) onLogLine(redactValues(line, secrets));
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
 * `docker build` argv. Build variables use the name-only `--build-arg KEY`
 * form, which tells docker to read the value from our environment, so values
 * never appear on a command line that `ps` can read.
 */
export function dockerBuildArgv(
  contextDir: string,
  imageTag: string,
  buildArgs?: BuildArgs | null
): string[] {
  const args = ["build", "-t", imageTag];
  for (const key of Object.keys(buildArgs ?? {})) {
    args.push("--build-arg", key);
  }
  args.push(contextDir);
  return args;
}

/**
 * `nixpacks build` argv. Unlike docker, nixpacks has no name-only `--env`
 * form, so values do go on the command line here; they are also placed in the
 * child environment so anything nixpacks shells out to sees the same thing.
 */
export function nixpacksArgv(
  contextDir: string,
  imageTag: string,
  opts: {
    buildCmd?: string | null;
    startCmd?: string | null;
    buildArgs?: BuildArgs | null;
  } = {}
): string[] {
  const args = ["build", contextDir, "--name", imageTag];
  if (opts.buildCmd?.trim()) {
    args.push("--build-cmd", opts.buildCmd);
  }
  if (opts.startCmd?.trim()) {
    args.push("--start-cmd", opts.startCmd);
  }
  for (const [key, value] of Object.entries(opts.buildArgs ?? {})) {
    args.push("--env", `${key}=${value}`);
  }
  return args;
}

/**
 * Build a Docker image from a Dockerfile at `contextDir/Dockerfile`.
 * Streams stdout/stderr to `onLogLine`.
 */
export async function dockerBuild(opts: DockerBuildOptions): Promise<void> {
  const { contextDir, imageTag, buildArgs, onLogLine } = opts;
  if (!hasDockerfile(contextDir)) {
    throw new Error(
      "No Dockerfile in repository root. Switch build mode to auto/nixpacks or add a Dockerfile."
    );
  }
  await runTool("docker", dockerBuildArgv(contextDir, imageTag, buildArgs), {
    onLogLine,
    tool: "docker build",
    env: buildArgs,
    secrets: Object.values(buildArgs ?? {})
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
  const { contextDir, imageTag, buildCmd, startCmd, buildArgs, onLogLine } = opts;
  const args = nixpacksArgv(contextDir, imageTag, {
    buildCmd,
    startCmd,
    buildArgs
  });
  await runTool("nixpacks", args, {
    onLogLine,
    tool: "nixpacks build",
    env: buildArgs,
    secrets: Object.values(buildArgs ?? {})
  });
}

/**
 * Pick a build engine based on `mode` and repo contents, then build.
 *
 * - `dockerfile`: require a Dockerfile, fail otherwise.
 * - `nixpacks`: always use Nixpacks.
 * - `auto`: Dockerfile wins if present, otherwise Nixpacks.
 */
export async function buildAppImage(opts: BuildOptions): Promise<BuildResult> {
  const { contextDir, imageTag, mode, buildCmd, startCmd, buildArgs, onLogLine } =
    opts;
  const hasDf = hasDockerfile(contextDir);

  const useDockerfile =
    mode === "dockerfile" || (mode === "auto" && hasDf);

  if (mode === "dockerfile" && !hasDf) {
    throw new Error(
      "Build mode is set to 'dockerfile' but no Dockerfile was found at the repo root."
    );
  }

  // Keys only. Values are image-visible but the build log is not the place to
  // publish them, and this line is the fastest way to confirm a variable
  // actually reached the build.
  const argKeys = Object.keys(buildArgs ?? {}).sort();
  if (argKeys.length > 0) {
    onLogLine(`[sohwe] Build variables: ${argKeys.join(", ")}`);
    if (useDockerfile) {
      onLogLine(
        `[sohwe] Note: a Dockerfile only sees these if it declares a matching ARG.`
      );
    }
  }

  if (useDockerfile) {
    onLogLine(`[sohwe] Engine: docker build (Dockerfile detected)`);
    if (buildCmd || startCmd) {
      onLogLine(
        `[sohwe] Note: build-cmd/start-cmd overrides are ignored in Dockerfile mode.`
      );
    }
    await dockerBuild({ contextDir, imageTag, buildArgs, onLogLine });
    return { imageTag, engine: "dockerfile" };
  }

  onLogLine(
    `[sohwe] Engine: nixpacks${
      mode === "auto" ? " (no Dockerfile found; auto-detecting runtime)" : ""
    }`
  );

  // Nixpacks falls back to Node 18 (end of life) when a repo pins nothing.
  // Fill in a supported LTS instead — only for Nixpacks, and only when neither
  // the user nor the repo has expressed a preference.
  const nodeVersion = resolveNodeVersion(contextDir, buildArgs);
  const resolvedArgs = nodeVersion.applied
    ? { ...buildArgs, [NODE_VERSION_KEY]: nodeVersion.version }
    : buildArgs;
  if (nodeVersion.applied) {
    onLogLine(
      `[sohwe] No Node version pinned by this repo; building with Node ${nodeVersion.version}.`
    );
    onLogLine(
      `[sohwe] Nixpacks would default to Node 18, which is end-of-life. Pin your own with an "engines.node" field, a .nvmrc, or a ${NODE_VERSION_KEY} build variable.`
    );
  }

  await nixpacksBuild({
    contextDir,
    imageTag,
    buildCmd,
    startCmd,
    buildArgs: resolvedArgs,
    onLogLine
  });
  return { imageTag, engine: "nixpacks" };
}

export {
  DEFAULT_NODE_VERSION,
  NODE_VERSION_KEY,
  resolveNodeVersion,
  type NodeVersionResolution
} from "./node-version";
