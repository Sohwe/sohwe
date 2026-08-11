import "dotenv/config";
import { prisma } from "@sohwe/db";
import { type ApiConfig, loadApiConfig } from "./env";
import { backfillRepoFullNames } from "./routes/github";
import { buildServer } from "./server";
import { startSessionCleanup } from "./session";

// Process entrypoint. Everything about what the API *is* lives in `server.ts`;
// this file owns only the things a running process needs — environment loading,
// binding a port, one-off boot work, and shutdown.

// Fail fast on a misconfigured environment, before opening a socket. process.exit
// returns `never`, so `config` is definitely an ApiConfig past this point.
function loadConfigOrExit(): ApiConfig {
  try {
    return loadApiConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
const config = loadConfigOrExit();

const app = await buildServer(config);

await app.listen({ port: config.port, host: "0.0.0.0" });

// One-off for installs predating Phase 5: derive `repoFullName` from `gitRepo`
// so existing apps can match incoming push webhooks.
void backfillRepoFullNames(app.log);

// Sweep expired session rows so the table doesn't grow without bound. Sessions
// are already rejected past expiry at read time; this reclaims the storage.
const stopSessionCleanup = startSessionCleanup(app.log);

process.on("SIGTERM", async () => {
  stopSessionCleanup();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
});
