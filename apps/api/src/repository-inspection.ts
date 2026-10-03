import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitHubRepoUrl } from "@sohwe/github";
import { getRepoInstallationToken } from "@sohwe/github/resolve";
import { AppDirectorySchema } from "@sohwe/types";
import { inspectCheckout, type RepositoryInspection } from "@sohwe/types/inspection";
export { inspectCheckout } from "@sohwe/types/inspection";

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

export async function inspectRepository(organizationId: string, gitRepo: string, branch: string, directory?: string, configPath?: string): Promise<RepositoryInspection> {
  if (!branch || branch.startsWith("-") || branch.includes("\0") || branch.length > 255) throw new Error("Enter a valid branch name.");
  if (directory && !AppDirectorySchema.safeParse(directory).success) throw new Error("App directory must stay inside the repository.");
  const token = await remoteAccess(organizationId, gitRepo);
  const temp = await mkdtemp(join(tmpdir(), "sohwe-inspect-"));
  try {
    const checkout = join(temp, "source");
    await runGit(["-c", "http.followRedirects=false", "-c", "protocol.file.allow=never", "clone", "--depth", "1", "--single-branch", "--branch", branch, "--", gitRepo, checkout], temp, 45_000, token);
    const commitSha = await runGit(["rev-parse", "HEAD"], checkout, 5_000);
    return await inspectCheckout(checkout, branch, commitSha, directory, configPath);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
