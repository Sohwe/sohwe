#!/usr/bin/env node
// Sohwe guided dev setup. One command from a fresh clone to a ready dev
// environment:
//
//   node scripts/dev-setup.mjs        (or, once deps exist: pnpm run setup)
//
// Checks the prerequisites (Node 24+, git, pnpm, Docker), installs
// dependencies, prepares the env files, starts the dev infrastructure
// (Postgres/Redis/Traefik), and applies database migrations.
//
// Idempotent: env values that are already configured are never overwritten —
// only missing files are created and only empty or `change-me` placeholders
// are filled in. Every other step is safe to re-run.
//
// Flags:
//   --skip-install   skip `pnpm install`
//   --skip-infra     skip `docker compose up` + the Postgres readiness wait
//   --skip-migrate   skip prisma generate + migrate deploy
//
// Plain Node builtins only, no dependencies — this must run before
// `pnpm install` on a machine that has nothing but Node. It cannot install
// the prerequisites themselves; when one is missing it says exactly what to
// install and where (docs/fresh-machine-setup.md).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

// Windows needs a shell to resolve pnpm.cmd / docker.exe shims.
const isWindows = process.platform === "win32";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint("1", s);
const log = (msg) => console.log(`${paint("34", "==>")} ${msg}`);
const ok = (msg) => console.log(`${paint("32", " ok")} ${msg}`);
const warn = (msg) => console.warn(`${paint("33", "warn")} ${msg}`);
const fail = (msg) => {
  console.error(`${paint("31", "err")} ${msg}`);
  process.exit(1);
};

const flags = { skipInstall: false, skipInfra: false, skipMigrate: false };
for (const arg of process.argv.slice(2)) {
  if (arg === "--skip-install") flags.skipInstall = true;
  else if (arg === "--skip-infra") flags.skipInfra = true;
  else if (arg === "--skip-migrate") flags.skipMigrate = true;
  else fail(`Unknown flag "${arg}". See scripts/dev-setup.mjs for usage.`);
}

// Every argument this script passes is a static literal (no user input), so
// joining to a single command string for the Windows shell is safe — and
// avoids Node's DEP0190 warning about shell:true with an args array.
function spawn(cmd, args, opts) {
  return isWindows
    ? spawnSync([cmd, ...args].join(" "), { ...opts, shell: true })
    : spawnSync(cmd, args, opts);
}

/** Run a command with live output; exit the script if it fails. */
function run(cmd, args, label = `${cmd} ${args.join(" ")}`) {
  const res = spawn(cmd, args, { stdio: "inherit" });
  if (res.error) fail(`${label} failed to start: ${res.error.message}`);
  if (res.status !== 0) fail(`${label} exited with status ${res.status}.`);
}

/** Run a command silently; return { ok, stdout }. Never throws. */
function capture(cmd, args) {
  const res = spawn(cmd, args, { encoding: "utf8" });
  return {
    ok: !res.error && res.status === 0,
    stdout: (res.stdout ?? "").trim()
  };
}

//---------------------------------------------------------------------------//
// Env file editing. Line-oriented so comments and ordering survive, and
// placeholder-only so a value someone already configured is never touched.
//---------------------------------------------------------------------------//

class EnvFile {
  constructor(content) {
    this.lines = content.split("\n");
    this.changes = [];
  }

  get(key) {
    const line = this.lines.find((l) => l.startsWith(`${key}=`));
    if (line === undefined) return undefined;
    return line.slice(key.length + 1).trim().replace(/^"(.*)"$/, "$1");
  }

  set(key, value, note = key) {
    const index = this.lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}="${value}"`;
    if (index === -1) this.lines.push(line);
    else this.lines[index] = line;
    this.changes.push(note);
  }

  /** True when the value is missing, empty, or still a change-me placeholder. */
  isPlaceholder(key) {
    const value = this.get(key);
    return value === undefined || value === "" || value.startsWith("change-me");
  }

  serialize() {
    return this.lines.join("\n");
  }
}

//---------------------------------------------------------------------------//
// 1. Prerequisites
//---------------------------------------------------------------------------//

log("Checking prerequisites…");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24) {
  fail(
    `Node ${process.versions.node} is too old — Sohwe needs Node 24+ (see .nvmrc). ` +
      "Install steps: docs/fresh-machine-setup.md"
  );
}
ok(`Node ${process.versions.node}`);

const git = capture("git", ["--version"]);
if (!git.ok) fail("git not found. Install steps: docs/fresh-machine-setup.md");
ok(git.stdout);

let pnpm = capture("pnpm", ["--version"]);
if (!pnpm.ok) {
  // pnpm is pinned via the packageManager field, so corepack (bundled with
  // Node) can activate it without a separate install.
  log("pnpm not found — trying `corepack enable`…");
  capture("corepack", ["enable"]);
  pnpm = capture("pnpm", ["--version"]);
}
if (!pnpm.ok) {
  fail(
    "pnpm not found and `corepack enable` did not fix it (it may need an " +
      "elevated shell). Run `corepack enable` as admin/sudo, or " +
      "`npm install -g pnpm@9`, then re-run this script."
  );
}
ok(`pnpm ${pnpm.stdout}`);

if (!capture("docker", ["--version"]).ok) {
  fail("Docker not found. Install steps: docs/fresh-machine-setup.md");
}
if (!capture("docker", ["compose", "version"]).ok) {
  fail(
    "`docker compose` (v2 plugin) not found. It ships with Docker Desktop; " +
      "on Linux install the docker-compose-plugin package."
  );
}
if (!capture("docker", ["info"]).ok) {
  fail(
    "The Docker daemon is not responding. Start Docker Desktop (or " +
      "`systemctl start docker` on Linux) and re-run this script."
  );
}
ok("Docker is installed and the daemon is running");

// Nixpacks is only needed to build apps without a root Dockerfile, so a
// missing binary is a heads-up, not a blocker.
const nixpacksFallback = join(homedir(), ".nixpacks", "bin", "nixpacks.exe");
if (!capture("nixpacks", ["--version"]).ok && !existsSync(nixpacksFallback)) {
  warn(
    "nixpacks not found — only needed to deploy apps without a Dockerfile. " +
      "Install later if you need it: docs/fresh-machine-setup.md"
  );
}

//---------------------------------------------------------------------------//
// 2. Dependencies
//---------------------------------------------------------------------------//

if (flags.skipInstall) {
  log("Skipping pnpm install (--skip-install).");
} else {
  log("Installing dependencies (pnpm install)…");
  run("pnpm", ["install"]);
}

//---------------------------------------------------------------------------//
// 3. Env files
//---------------------------------------------------------------------------//

log("Preparing env files…");

function loadOrCreate(target, example) {
  if (existsSync(target)) {
    return { env: new EnvFile(readFileSync(target, "utf8")), created: false };
  }
  if (!existsSync(example)) fail(`Missing ${example} — is the checkout intact?`);
  return { env: new EnvFile(readFileSync(example, "utf8")), created: true };
}

const apiEnvPath = "apps/api/.env";
const { env: apiEnv, created: apiCreated } = loadOrCreate(
  apiEnvPath,
  "apps/api/.env.example"
);

// Secrets are always machine-generated, never typed by a person. Only
// placeholders are filled: an existing key is load-bearing (it encrypted the
// env vars already in the dev database) and is left strictly alone.
if (apiEnv.isPlaceholder("SESSION_SECRET")) {
  apiEnv.set("SESSION_SECRET", randomBytes(32).toString("hex"), "generated SESSION_SECRET");
}
if (apiEnv.isPlaceholder("SOHWE_ENCRYPTION_KEY")) {
  apiEnv.set(
    "SOHWE_ENCRYPTION_KEY",
    randomBytes(32).toString("base64"),
    "generated SOHWE_ENCRYPTION_KEY"
  );
}

if (apiCreated || apiEnv.changes.length > 0) {
  writeFileSync(apiEnvPath, apiEnv.serialize());
  ok(
    apiCreated
      ? `Generated ${apiEnvPath} with fresh secrets.`
      : `Filled in ${apiEnvPath}: ${apiEnv.changes.join(", ")}.`
  );
} else {
  ok(`${apiEnvPath} already configured — nothing changed.`);
}

const dbEnvPath = "packages/db/.env";
if (existsSync(dbEnvPath)) {
  ok(`${dbEnvPath} already exists — kept as-is.`);
} else {
  if (!existsSync("packages/db/.env.example")) {
    fail("Missing packages/db/.env.example — is the checkout intact?");
  }
  writeFileSync(dbEnvPath, readFileSync("packages/db/.env.example", "utf8"));
  ok(`Created ${dbEnvPath}.`);
}

//---------------------------------------------------------------------------//
// 4. Infrastructure (Postgres, Redis, Traefik)
//---------------------------------------------------------------------------//

if (flags.skipInfra) {
  log("Skipping infrastructure (--skip-infra).");
} else {
  log("Starting dev infrastructure (docker compose)…");
  run("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "-d"]);

  // Wait for Postgres before running migrations. The container name is fixed
  // in docker-compose.dev.yml.
  log("Waiting for Postgres to accept connections…");
  let pgReady = false;
  for (let i = 0; i < 30; i++) {
    if (
      capture("docker", [
        "exec",
        "sohwe-db-dev",
        "pg_isready",
        "-U",
        "sohwe",
        "-d",
        "sohwe_dev"
      ]).ok
    ) {
      pgReady = true;
      break;
    }
    await sleep(2000);
  }
  if (!pgReady) {
    fail(
      "Postgres did not become ready within 60s. Check " +
        "`docker compose -f docker-compose.dev.yml logs postgres`."
    );
  }
  ok("Postgres is ready.");
}

//---------------------------------------------------------------------------//
// 5. Database
//---------------------------------------------------------------------------//

if (flags.skipMigrate) {
  log("Skipping database preparation (--skip-migrate).");
} else {
  log("Generating the Prisma client…");
  run("pnpm", ["db:generate"]);

  log("Applying database migrations…");
  run("pnpm", ["db:migrate:deploy"]);
}

//---------------------------------------------------------------------------//
// Done
//---------------------------------------------------------------------------//

console.log(`
${paint("32", bold("Sohwe dev environment is ready."))}

Start everything with:

  ${bold("pnpm dev")}

  Dashboard:  http://localhost:3000
  API:        http://localhost:3001 (GET /health)

First visit walks you through creating the owner account and organization.
Deployed apps come up at http://<slug>.sohwe.localhost (Traefik on port 80).

Your secrets live in ${apiEnvPath} — losing SOHWE_ENCRYPTION_KEY makes every
encrypted env var in the dev database unreadable, so don't regenerate it.
`);
