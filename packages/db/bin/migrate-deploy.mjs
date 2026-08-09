#!/usr/bin/env node
/**
 * Applies Sohwe's versioned Prisma migrations, baselining pre-migration
 * databases on the way.
 *
 * This runs as the one-shot `migrate` service in docker-compose.prod.yml, which
 * the api and worker are gated behind, so every `docker compose up -d` brings
 * the schema forward before any application code touches it. It replaces the
 * `sohwe migrate` / `sohwe migrate-status` subcommands of the old host CLI.
 *
 * Three possible database states:
 *
 *   1. Fresh install     -- empty database; deploy applies every migration.
 *   2. Already migrated  -- `_prisma_migrations` exists; deploy applies only
 *                           what is new.
 *   3. Pre-migration install (<= v0.3.8, schema created by `db push`) --
 *                           deploy refuses with P3005 "schema is not empty".
 *
 * Case 3 is unambiguous: every tag up to v0.3.8 shipped a byte-identical
 * schema, so such a database is exactly the `init` migration. We mark init as
 * already-applied and re-run deploy, which then applies only the later
 * migrations. Baselining writes one row to `_prisma_migrations`; it runs no DDL
 * and cannot lose data.
 *
 * Usage:
 *   node bin/migrate-deploy.mjs             apply pending migrations
 *   node bin/migrate-deploy.mjs --status    report drift, change nothing
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The `init` migration reproduces the schema that every published tag up to and
// including v0.3.8 shipped. Never renumber it -- see CLAUDE.md.
const BASELINE_MIGRATION = "20260722000000_init";

// Resolve the package root from this file rather than trusting the caller's
// cwd, so the script behaves the same from /app, from packages/db, or from a
// `docker compose run` with no working_dir.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * pnpm resolves the prisma CLI from packages/db's own devDependencies. This is
 * how the API image has shipped Prisma since v0.3.8, and matches how the old
 * `sohwe` CLI invoked it.
 */
function runPrisma(args, { capture = false } = {}) {
  const result = spawnSync("pnpm", ["exec", "prisma", ...args], {
    cwd: packageRoot,
    // pnpm is a .cmd shim on Windows, which cannot be exec'd directly.
    shell: process.platform === "win32",
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });

  if (result.error) {
    console.error(`Could not run the Prisma CLI: ${result.error.message}`);
    process.exit(1);
  }

  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    output: capture ? `${result.stdout ?? ""}${result.stderr ?? ""}` : ""
  };
}

// Prisma reads packages/db/.env itself when DATABASE_URL is absent from the
// environment, so only fail when neither source can supply it. In the container
// it always comes from the compose environment.
if (!process.env.DATABASE_URL && !existsSync(resolve(packageRoot, ".env"))) {
  console.error(
    "DATABASE_URL is not set and packages/db/.env does not exist.\n" +
      "In production it is passed to the `migrate` service by " +
      "docker-compose.prod.yml; check that it is set in .env."
  );
  process.exit(1);
}

if (process.argv.slice(2).includes("--status")) {
  process.exit(runPrisma(["migrate", "status"]).status);
}

const deploy = runPrisma(["migrate", "deploy"], { capture: true });

if (deploy.ok) {
  process.stdout.write(deploy.output);
  process.exit(0);
}

if (!deploy.output.includes("P3005")) {
  process.stderr.write(deploy.output);
  process.exit(deploy.status);
}

console.log("Existing pre-migration database detected.");
console.log(`Baselining at ${BASELINE_MIGRATION} (records history only, no schema change)...`);

const resolved = runPrisma(["migrate", "resolve", "--applied", BASELINE_MIGRATION]);
if (!resolved.ok) {
  process.exit(resolved.status);
}

process.exit(runPrisma(["migrate", "deploy"]).status);
