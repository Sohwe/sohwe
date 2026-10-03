import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { parseGitHubRepoUrl } from "@sohwe/github";
import { getRepoInstallationToken } from "@sohwe/github/resolve";

export type InspectionEvidence = { path: string; detail: string };
export type InspectionCandidate = {
  directory: string;
  buildMode: "dockerfile" | "nixpacks";
  dockerfilePath: string;
  buildCmd: string | null;
  startCmd: string | null;
  startDisplay: string | null;
  runtimeCmd: string | null;
  port: number;
  evidence: InspectionEvidence[];
};
export type RepositoryInspection = {
  commitSha: string;
  branch: string;
  candidates: InspectionCandidate[];
  selected: InspectionCandidate;
  buildContext: ".";
};

const MAX_FILE = 64 * 1024;
const MAX_CANDIDATES = 24;
const MAX_DEPTH = 3;

function safeRelative(path: string): boolean {
  return path === "." || (!path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && !path.split("/").includes(".."));
}

async function safeFile(root: string, path: string): Promise<string | null> {
  if (!safeRelative(path)) return null;
  try {
    const target = resolve(root, path);
    const actual = await realpath(target);
    const fromRoot = relative(await realpath(root), actual);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return null;
    const info = await stat(actual);
    if (!info.isFile() || info.size > MAX_FILE) return null;
    return await readFile(actual, "utf8");
  } catch { return null; }
}

async function safeDirectory(root: string, path: string): Promise<boolean> {
  if (!safeRelative(path)) return false;
  try {
    const actual = await realpath(resolve(root, path));
    const fromRoot = relative(await realpath(root), actual);
    return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && (await stat(actual)).isDirectory();
  } catch { return false; }
}

function packageManager(root: Record<string, unknown> | null, filenames: Set<string>): "pnpm" | "yarn" | "npm" {
  const declared = typeof root?.packageManager === "string" ? root.packageManager.split("@")[0] : null;
  if (declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
  if (filenames.has("pnpm-lock.yaml")) return "pnpm";
  if (filenames.has("yarn.lock")) return "yarn";
  return "npm";
}

function scriptCommand(manager: "pnpm" | "yarn" | "npm", directory: string, name: string, packageName?: string): string {
  if (directory === ".") return manager === "yarn" ? `yarn ${name}` : `${manager} run ${name}`;
  if (packageName) {
    if (manager === "pnpm") return `pnpm --filter ${JSON.stringify(packageName)} ${name}`;
    if (manager === "yarn") return `yarn workspace ${JSON.stringify(packageName)} ${name}`;
    return `npm run ${name} --workspace ${JSON.stringify(packageName)}`;
  }
  const quotedDirectory = `'${directory.replaceAll("'", "'\"'\"'")}'`;
  return manager === "yarn" ? `cd ${quotedDirectory} && yarn ${name}` : `cd ${quotedDirectory} && ${manager} run ${name}`;
}

function portFromText(text: string): number | null {
  const matches = [...text.matchAll(/(?:EXPOSE\s+|(?:PORT|port)\s*[:=]\s*|--port(?:=|\s+)|\.listen\(\s*)(\d{2,5})/g)];
  const value = Number(matches.at(-1)?.[1]);
  return value >= 1 && value <= 65535 ? value : null;
}

async function candidate(root: string, directory: string, manager: "pnpm" | "yarn" | "npm", rootPackage: Record<string, unknown> | null): Promise<InspectionCandidate | null> {
  const manifestPath = directory === "." ? "package.json" : `${directory}/package.json`;
  const dockerfilePath = directory === "." ? "Dockerfile" : `${directory}/Dockerfile`;
  const dockerfile = await safeFile(root, dockerfilePath);
  const manifest = await safeFile(root, manifestPath);
  const requirements = await safeFile(root, directory === "." ? "requirements.txt" : `${directory}/requirements.txt`);
  const pyproject = await safeFile(root, directory === "." ? "pyproject.toml" : `${directory}/pyproject.toml`);
  const goMod = await safeFile(root, directory === "." ? "go.mod" : `${directory}/go.mod`);
  if (dockerfile === null && manifest === null && requirements === null && pyproject === null && goMod === null) return null;
  const evidence: InspectionEvidence[] = [];
  let pkg: Record<string, unknown> | null = null;
  if (manifest) {
    try { pkg = JSON.parse(manifest) as Record<string, unknown>; } catch { evidence.push({ path: manifestPath, detail: "Could not parse package.json; check it before deploying." }); }
  }
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts as Record<string, unknown> : {};
  const packageName = typeof pkg?.name === "string" && /^[\w@./-]+$/.test(pkg.name) ? pkg.name : undefined;
  const pnpmWorkspace = await safeFile(root, "pnpm-workspace.yaml") !== null;
  const turboWorkspace = await safeFile(root, "turbo.json") !== null;
  const isWorkspace = directory !== "." && !!pkg && (pnpmWorkspace || rootPackage?.workspaces !== undefined || turboWorkspace);
  const commandFor = (script: string) => scriptCommand(manager, isWorkspace ? directory : ".", script, isWorkspace ? packageName : undefined);
  let buildCmd: string | null = null;
  let startCmd: string | null = null;
  if (pkg) {
    evidence.push({ path: manifestPath, detail: `Node package${packageName ? ` ${packageName}` : ""}; scripts: ${Object.keys(scripts).filter((key) => key === "build" || key === "start").join(", ") || "none"}.` });
    if (typeof scripts.build === "string") buildCmd = commandFor("build");
    if (typeof scripts.start === "string") startCmd = commandFor("start");
  }
  if (requirements !== null) evidence.push({ path: directory === "." ? "requirements.txt" : `${directory}/requirements.txt`, detail: "Python dependencies detected; review the start command." });
  if (pyproject !== null) evidence.push({ path: directory === "." ? "pyproject.toml" : `${directory}/pyproject.toml`, detail: "Python project detected; review the start command." });
  if (goMod !== null) evidence.push({ path: directory === "." ? "go.mod" : `${directory}/go.mod`, detail: "Go module detected; review the start command." });
  if (dockerfile !== null) evidence.push({ path: dockerfilePath, detail: "Dockerfile found; its CMD or ENTRYPOINT controls startup unless overridden." });
  const dockerStart = dockerfile?.match(/^\s*(?:CMD|ENTRYPOINT)\s+(.+)$/gim)?.at(-1)?.trim().slice(0, 240) ?? null;
  const port = portFromText(dockerfile ?? "") ?? portFromText(manifest ?? "") ?? 3000;
  evidence.push({ path: dockerfile !== null ? dockerfilePath : manifest !== null ? manifestPath : directory, detail: port === 3000 ? "Container port defaults to 3000; confirm what the process listens on." : `Port ${port} appears in repository configuration; confirm the process listens on it.` });
  if (isWorkspace) evidence.push({ path: pnpmWorkspace ? "pnpm-workspace.yaml" : rootPackage?.workspaces !== undefined ? "package.json" : "turbo.json", detail: "Workspace build uses the repository root as context." });
  return { directory, buildMode: dockerfile !== null ? "dockerfile" : "nixpacks", dockerfilePath, buildCmd: dockerfile !== null ? null : buildCmd, startCmd: dockerfile !== null ? null : startCmd, startDisplay: dockerfile !== null ? dockerStart : startCmd, runtimeCmd: null, port, evidence };
}

/** Read only a bounded list of conventional application locations. Never read .env values. */
export async function inspectCheckout(root: string, branch: string, commitSha: string, requestedDirectory?: string): Promise<RepositoryInspection> {
  if (requestedDirectory && !await safeDirectory(root, requestedDirectory)) throw new Error("App directory does not exist in this branch.");
  const entries = await readdir(root, { withFileTypes: true });
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const rootManifest = await safeFile(root, "package.json");
  let rootPackage: Record<string, unknown> | null = null;
  try { rootPackage = rootManifest ? JSON.parse(rootManifest) as Record<string, unknown> : null; } catch { /* evidence appears on candidate */ }
  const manager = packageManager(rootPackage, files);
  const directories = new Set(["."]);
  async function discover(base: string, depth: number): Promise<void> {
    if (depth >= MAX_DEPTH || directories.size >= MAX_CANDIDATES) return;
    const children = await readdir(resolve(root, base), { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith(".") || ["node_modules", "vendor", "dist", "build", "coverage", "test", "tests", "examples"].includes(child.name)) continue;
      const path = base === "." ? child.name : `${base}/${child.name}`;
      if (!await safeDirectory(root, path)) continue;
      directories.add(path);
      if (directories.size >= MAX_CANDIDATES) break;
      if (base === "." && ["apps", "packages", "services"].includes(child.name)) await discover(path, depth + 1);
    }
  }
  await discover(".", 0);
  if (requestedDirectory) directories.add(requestedDirectory);
  const found = (await Promise.all([...directories].map((dir) => candidate(root, dir, manager, rootPackage)))).filter((item): item is InspectionCandidate => item !== null);
  if (found.length === 0) found.push({ directory: ".", buildMode: "nixpacks", dockerfilePath: "Dockerfile", buildCmd: null, startCmd: null, startDisplay: null, runtimeCmd: null, port: 3000, evidence: [{ path: ".", detail: "No supported project manifest or Dockerfile found. Choose settings manually." }] });
  if (requestedDirectory && !found.some((item) => item.directory === requestedDirectory)) {
    found.push({ directory: requestedDirectory, buildMode: "nixpacks", dockerfilePath: `${requestedDirectory}/Dockerfile`, buildCmd: null, startCmd: null, startDisplay: null, runtimeCmd: null, port: 3000, evidence: [{ path: requestedDirectory, detail: "Directory exists, but no Dockerfile or supported manifest was found. Set build and start commands manually." }] });
  }
  found.sort((a, b) => a.directory === "." ? -1 : b.directory === "." ? 1 : a.directory.localeCompare(b.directory));
  const selected = found.find((item) => item.directory === requestedDirectory) ?? found.find((item) => item.directory === "." && (item.buildMode === "dockerfile" || item.startCmd)) ?? found.find((item) => item.directory.startsWith("apps/") && (item.startCmd || item.buildMode === "dockerfile")) ?? found[0]!;
  return { commitSha, branch, candidates: found, selected, buildContext: "." };
}

function runGit(args: string[], cwd: string, timeout = 45_000, token?: string, maxOutputBytes = 4096): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const auth = token ? {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
    } : {};
    const gitProcess = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...auth }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => gitProcess.kill("SIGKILL"), timeout);
    gitProcess.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > maxOutputBytes) gitProcess.kill("SIGKILL");
    });
    gitProcess.on("error", reject);
    gitProcess.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveResult(output.trim());
      else reject(new Error("Git repository or branch could not be read."));
    });
  });
}

async function remoteAccess(organizationId: string, gitRepo: string): Promise<string | undefined> {
  const url = new URL(gitRepo);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname || !url.pathname || url.pathname === "/") throw new Error("Use an HTTPS repository URL without credentials or query parameters.");
  // The API fetches source supplied by an admin. Refuse loopback and private
  // destinations before invoking Git, and disable Git's HTTP redirects below.
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => {
    if (isIP(address) === 4) {
      const [a, b] = address.split(".").map(Number);
      return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a! >= 224;
    }
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("::ffff:");
  })) throw new Error("Use a publicly reachable HTTPS repository host.");
  const ref = parseGitHubRepoUrl(gitRepo);
  const installation = ref ? await getRepoInstallationToken(organizationId, ref).catch(() => null) : null;
  return installation?.token.token;
}

export function parseBranchRefs(output: string): { branches: string[]; defaultBranch: string | null; truncated: boolean } {
  const branchNames = new Set<string>();
  let defaultBranch: string | null = null;
  for (const line of output.split("\n")) {
    const symref = /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line.trim());
    if (symref) defaultBranch = symref[1]!;
    const ref = /^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/.exec(line.trim());
    if (ref) branchNames.add(ref[1]!);
  }
  const all = [...branchNames].sort((a, b) => a.localeCompare(b));
  const branches = defaultBranch && all.includes(defaultBranch)
    ? [defaultBranch, ...all.filter((name) => name !== defaultBranch)].slice(0, 100)
    : all.slice(0, 100);
  return { branches, defaultBranch, truncated: all.length > branches.length };
}

export async function listRepositoryBranches(organizationId: string, gitRepo: string): Promise<{ branches: string[]; defaultBranch: string | null; truncated: boolean }> {
  const token = await remoteAccess(organizationId, gitRepo);
  const output = await runGit(
    ["-c", "http.followRedirects=false", "-c", "protocol.file.allow=never", "ls-remote", "--symref", gitRepo, "HEAD", "refs/heads/*"],
    process.cwd(), 30_000, token, 1024 * 1024
  );
  return parseBranchRefs(output);
}

export async function inspectRepository(organizationId: string, gitRepo: string, branch: string, directory?: string): Promise<RepositoryInspection> {
  if (!branch || branch.startsWith("-") || branch.includes("\0") || branch.length > 255) throw new Error("Enter a valid branch name.");
  if (directory && !safeRelative(directory)) throw new Error("App directory must stay inside the repository.");
  const token = await remoteAccess(organizationId, gitRepo);
  const temp = await mkdtemp(join(tmpdir(), "sohwe-inspect-"));
  try {
    const checkout = join(temp, "source");
    await runGit(["-c", "http.followRedirects=false", "-c", "protocol.file.allow=never", "clone", "--depth", "1", "--single-branch", "--branch", branch, "--", gitRepo, checkout], temp, 45_000, token);
    const commitSha = await runGit(["rev-parse", "HEAD"], checkout, 5_000);
    return await inspectCheckout(checkout, branch, commitSha, directory);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
