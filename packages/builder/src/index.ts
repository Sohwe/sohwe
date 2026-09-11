import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /** Dockerfile path relative to `contextDir`. Defaults to `Dockerfile`. */
  dockerfilePath?: string | null;
  /** Optional named stage from a multi-stage Dockerfile. */
  dockerTarget?: string | null;
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
  dockerfilePath?: string | null;
  dockerTarget?: string | null;
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

const DEFAULT_DOCKERFILE = "Dockerfile";
const DOCKER_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolve a repository-relative Dockerfile without allowing it to escape the
 * cloned build context. The realpath check closes the symlink version of the
 * same escape; repositories are untrusted input to the worker.
 */
export function resolveDockerfilePath(
  contextDir: string,
  dockerfilePath?: string | null
): string {
  const configured = dockerfilePath?.trim() || DEFAULT_DOCKERFILE;
  if (configured.includes("\0") || isAbsolute(configured)) {
    throw new Error("Dockerfile path must be relative to the repository root.");
  }

  const contextRoot = resolve(contextDir);
  const candidate = resolve(contextRoot, configured);
  const fromRoot = relative(contextRoot, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Dockerfile path must stay inside the repository root.");
  }

  if (existsSync(candidate)) {
    const realRoot = realpathSync(contextRoot);
    const realCandidate = realpathSync(candidate);
    const realFromRoot = relative(realRoot, realCandidate);
    if (
      realFromRoot === ".." ||
      realFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(realFromRoot)
    ) {
      throw new Error("Dockerfile path resolves outside the repository root.");
    }
    if (!statSync(realCandidate).isFile()) {
      throw new Error(`Dockerfile path is not a file: ${configured}`);
    }
    return realCandidate;
  }

  return candidate;
}

/**
 * Validate a target again at the worker boundary. API validation is not a
 * substitute here: old rows, restores, or direct database edits are still
 * untrusted input to a command-line parser.
 */
export function resolveDockerTarget(dockerTarget?: string | null): string | null {
  const target = dockerTarget?.trim();
  if (!target) return null;
  if (target.length > 128 || !DOCKER_TARGET_PATTERN.test(target)) {
    throw new Error(
      "Docker target may contain only letters, numbers, dots, underscores, and hyphens."
    );
  }
  return target;
}

function hasDockerfile(dir: string, dockerfilePath?: string | null): boolean {
  return existsSync(resolveDockerfilePath(dir, dockerfilePath));
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
  buildArgs?: BuildArgs | null,
  opts: { dockerfilePath?: string | null; dockerTarget?: string | null } = {}
): string[] {
  const args = ["build", "-t", imageTag];
  const configuredPath = opts.dockerfilePath?.trim();
  if (configuredPath && configuredPath !== DEFAULT_DOCKERFILE) {
    args.push("--file", resolveDockerfilePath(contextDir, configuredPath));
  }
  const dockerTarget = resolveDockerTarget(opts.dockerTarget);
  if (dockerTarget) {
    args.push("--target", dockerTarget);
  }
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
 * Build a Docker image from a repository-relative Dockerfile while retaining
 * the repository root as its build context.
 * Streams stdout/stderr to `onLogLine`.
 */
export async function dockerBuild(opts: DockerBuildOptions): Promise<void> {
  const {
    contextDir,
    imageTag,
    dockerfilePath,
    dockerTarget,
    buildArgs,
    onLogLine
  } = opts;
  if (!hasDockerfile(contextDir, dockerfilePath)) {
    const configured = dockerfilePath?.trim() || DEFAULT_DOCKERFILE;
    throw new Error(
      `Dockerfile not found at ${configured}. Switch build mode to auto/nixpacks or correct the Dockerfile path.`
    );
  }
  await runTool(
    "docker",
    dockerBuildArgv(contextDir, imageTag, buildArgs, {
      dockerfilePath,
      dockerTarget
    }),
    {
      onLogLine,
      tool: "docker build",
      env: buildArgs,
      secrets: Object.values(buildArgs ?? {})
    }
  );
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
  const {
    contextDir,
    imageTag,
    mode,
    buildCmd,
    startCmd,
    dockerfilePath,
    dockerTarget,
    buildArgs,
    onLogLine
  } = opts;
  const hasDf = hasDockerfile(contextDir, dockerfilePath);
  const configuredDockerfile = dockerfilePath?.trim() || DEFAULT_DOCKERFILE;
  const configuredTarget = resolveDockerTarget(dockerTarget);

  const useDockerfile =
    mode === "dockerfile" || (mode === "auto" && hasDf);

  if (mode === "dockerfile" && !hasDf) {
    throw new Error(
      `Build mode is set to 'dockerfile' but ${configuredDockerfile} was not found in the repository.`
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
    onLogLine(
      `[sohwe] Engine: docker build (${configuredDockerfile}${
        configuredTarget ? `, target ${configuredTarget}` : ""
      })`
    );
    if (buildCmd) {
      onLogLine(
        `[sohwe] Note: build-cmd override is ignored in Dockerfile mode.`
      );
    }
    await dockerBuild({
      contextDir,
      imageTag,
      dockerfilePath,
      dockerTarget,
      buildArgs,
      onLogLine
    });
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
