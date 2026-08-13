import { randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "@sohwe/crypto";
import { prisma } from "@sohwe/db";
import {
  DATASTORE_DELETE_JOB,
  DATASTORE_PROVISION_JOB,
  DATASTORE_QUEUE,
  DATASTORE_ROTATE_JOB,
  createDatastoreQueue,
  getConnectionOptionsForBull,
  Queue,
  Worker,
  type DatastoreJobData
} from "@sohwe/queue";
import {
  appInternalNetworkName,
  buildDatastoreConnectionUrl,
  DATASTORE_LABEL,
  datastoreContainerName,
  datastoreServicePort,
  datastoreVolumeName,
  type DatastoreCredentials,
  type DatastoreKind
} from "@sohwe/types";
import type Docker from "dockerode";
import { buildDatastoreContainerSpec, datastoreImage } from "./datastore-spec";

// Managed datastore lifecycle (Phase 7): provision, delete, and password
// rotation for Sohwe-owned Postgres/Redis containers. Everything here is
// idempotent so a retried BullMQ job re-runs safely, and no credential ever
// enters a log line, an error message, or a Docker exec argv.

/** How long provisioning waits for the engine to answer before failing. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 2_000;

type DatastoreRow = {
  id: string;
  slug: string;
  kind: string;
  engineVersion: string;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  publicPort: number | null;
  credentialsEncrypted: Uint8Array;
  bindings: { applicationId: string; envKeys: string[] }[];
};

function readCreds(row: DatastoreRow): DatastoreCredentials {
  const raw = row.credentialsEncrypted;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const vars = decryptJson(buf);
  if (!vars.password) throw new Error("Datastore credentials are missing a password");
  return {
    username: vars.username,
    password: vars.password,
    database: vars.database
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip any known secret from a message before it can be stored or logged. */
function redactSecrets(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) {
    if (s) out = out.split(s).join("•••");
  }
  return out;
}

function statusCodeOf(e: unknown): number | undefined {
  return e && typeof e === "object" && "statusCode" in e
    ? Number((e as { statusCode?: number }).statusCode)
    : undefined;
}

/** Pull the image if it is not present locally. */
async function ensureImage(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch (e) {
    if (statusCodeOf(e) !== 404) throw e;
  }
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Idempotently create an app's internal network. Byte-identical to the deploy
 * path's network creation, because a datastore can be bound to an app that has
 * never deployed.
 */
async function ensureAppNetwork(docker: Docker, appId: string): Promise<void> {
  try {
    await docker.createNetwork({
      Name: appInternalNetworkName(appId),
      Driver: "bridge",
      Internal: true,
      Labels: { "sohwe.managed": "true", "sohwe.app": appId }
    });
  } catch {
    // already exists
  }
}

async function connectNetwork(
  docker: Docker,
  networkName: string,
  containerId: string
): Promise<void> {
  try {
    await docker.getNetwork(networkName).connect({ Container: containerId });
  } catch (e) {
    // 403: endpoint already exists on the network — fine on a retried job.
    if (statusCodeOf(e) !== 403) throw e;
  }
}

async function ensureVolume(docker: Docker, ds: DatastoreRow): Promise<void> {
  const name = datastoreVolumeName(ds.id);
  try {
    await docker.getVolume(name).inspect();
  } catch {
    await docker.createVolume({
      Name: name,
      Labels: { "sohwe.managed": "true", [DATASTORE_LABEL]: ds.id }
    });
  }
}

/**
 * (Re)create and start the datastore container from the current row state,
 * then attach it to every bound app's internal network. Used by provision and
 * by redis password rotation; recreating from an existing data volume is safe
 * for both engines.
 */
async function startDatastoreContainer(
  docker: Docker,
  ds: DatastoreRow,
  creds: DatastoreCredentials
): Promise<void> {
  const kind = ds.kind as DatastoreKind;
  await ensureImage(docker, datastoreImage(kind, ds.engineVersion));
  await ensureVolume(docker, ds);

  // Recreate-if-exists, but only a container that is provably ours: a stale
  // container from a failed attempt or a config change carries this
  // datastore's label. Anything else holding the name is not touched.
  const name = datastoreContainerName(ds.slug);
  const existing = docker.getContainer(name);
  try {
    const info = await existing.inspect();
    if (info.Config?.Labels?.[DATASTORE_LABEL] !== ds.id) {
      throw new Error(`Container name ${name} is taken by an unmanaged container`);
    }
    await existing.stop({ t: 10 }).catch(() => {});
    await existing.remove().catch(() => {});
  } catch (e) {
    if (statusCodeOf(e) !== 404) throw e;
  }

  const c = await docker.createContainer(
    buildDatastoreContainerSpec({
      id: ds.id,
      slug: ds.slug,
      kind,
      engineVersion: ds.engineVersion,
      memoryLimitMb: ds.memoryLimitMb,
      cpuLimit: ds.cpuLimit,
      publicPort: ds.publicPort,
      creds
    })
  );
  await c.start();

  for (const b of ds.bindings) {
    await ensureAppNetwork(docker, b.applicationId);
    await connectNetwork(docker, appInternalNetworkName(b.applicationId), c.id);
  }

  // Private datastores leave the default bridge so they are reachable only on
  // bound apps' internal networks. Public ones keep the bridge endpoint —
  // published ports do not function on internal-only networks.
  if (ds.publicPort == null) {
    await docker
      .getNetwork("bridge")
      .disconnect({ Container: c.id, Force: true })
      .catch(() => {});
  }
}

/** Run a command in the container and report its exit code. */
async function execInDatastore(
  docker: Docker,
  containerName: string,
  cmd: string[],
  env: string[]
): Promise<number> {
  const container = docker.getContainer(containerName);
  const exec = await container.exec({
    Cmd: cmd,
    Env: env,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve) => {
    stream.on("data", () => {});
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", () => {
      resolve();
    });
  });
  const info = await exec.inspect();
  return info.ExitCode ?? 1;
}

/**
 * Poll until the engine answers. `pg_isready` needs no password; `redis-cli`
 * takes its auth from `REDISCLI_AUTH` so the password never appears in argv.
 */
async function waitUntilReady(
  docker: Docker,
  ds: DatastoreRow,
  creds: DatastoreCredentials
): Promise<void> {
  const name = datastoreContainerName(ds.slug);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const exit =
        ds.kind === "postgres"
          ? await execInDatastore(
              docker,
              name,
              ["pg_isready", "-U", creds.username ?? "sohwe"],
              []
            )
          : await execInDatastore(docker, name, ["redis-cli", "ping"], [
              `REDISCLI_AUTH=${creds.password}`
            ]);
      if (exit === 0) return;
    } catch {
      // Container may not accept execs yet; keep polling.
    }
    if (Date.now() >= deadline) {
      throw new Error("Datastore did not become ready within 60s");
    }
    await sleep(READY_POLL_MS);
  }
}

/**
 * Rewrite the env var keys each binding injected, using the current
 * credentials. Called after a rotation so bound apps get the new URL on their
 * next deploy instead of keeping a stale password forever.
 */
async function rewriteBoundEnvKeys(
  ds: DatastoreRow,
  creds: DatastoreCredentials
): Promise<void> {
  const kind = ds.kind as DatastoreKind;
  const url = buildDatastoreConnectionUrl(
    kind,
    creds,
    datastoreContainerName(ds.slug),
    datastoreServicePort(kind)
  );
  for (const b of ds.bindings) {
    if (b.envKeys.length === 0) continue;
    const app = await prisma.application.findUnique({
      where: { id: b.applicationId },
      select: { id: true, envVarsEncrypted: true }
    });
    if (!app) continue;
    const enc = app.envVarsEncrypted;
    const map = enc
      ? decryptJson(Buffer.isBuffer(enc) ? enc : Buffer.from(enc))
      : {};
    for (const key of b.envKeys) map[key] = url;
    await prisma.application.update({
      where: { id: app.id },
      data: { envVarsEncrypted: encryptJson(map) }
    });
  }
}

async function loadDatastore(datastoreId: string): Promise<DatastoreRow | null> {
  return prisma.datastore.findUnique({
    where: { id: datastoreId },
    include: { bindings: { select: { applicationId: true, envKeys: true } } }
  });
}

async function runProvision(docker: Docker, datastoreId: string): Promise<void> {
  const ds = await loadDatastore(datastoreId);
  if (!ds) return; // deleted while queued
  const creds = readCreds(ds);
  await startDatastoreContainer(docker, ds, creds);
  await waitUntilReady(docker, ds, creds);
  await prisma.datastore.update({
    where: { id: ds.id },
    data: { status: "running", errorMessage: null }
  });
}

async function runDelete(docker: Docker, datastoreId: string): Promise<void> {
  const ds = await loadDatastore(datastoreId);
  if (!ds) return;

  const name = datastoreContainerName(ds.slug);
  const container = docker.getContainer(name);
  try {
    const info = await container.inspect();
    if (info.Config?.Labels?.[DATASTORE_LABEL] === ds.id) {
      for (const net of Object.keys(info.NetworkSettings?.Networks ?? {})) {
        await docker
          .getNetwork(net)
          .disconnect({ Container: info.Id, Force: true })
          .catch(() => {});
      }
      await container.stop({ t: 10 }).catch(() => {});
      await container.remove().catch(() => {});
    }
  } catch (e) {
    if (statusCodeOf(e) !== 404) throw e;
  }

  try {
    await docker.getVolume(datastoreVolumeName(ds.id)).remove({ force: true });
  } catch (e) {
    if (statusCodeOf(e) !== 404) throw e;
  }

  // Row goes last so a mid-way crash leaves a retryable job, not an orphan.
  await prisma.datastore.delete({ where: { id: ds.id } }).catch(() => {});
}

async function runRotate(docker: Docker, datastoreId: string): Promise<void> {
  const ds = await loadDatastore(datastoreId);
  if (!ds) return;
  const creds = readCreds(ds);
  const newPassword = randomBytes(24).toString("base64url");
  const newCreds: DatastoreCredentials = { ...creds, password: newPassword };

  if (ds.kind === "postgres") {
    // POSTGRES_PASSWORD only applies at initdb, so the running server is
    // updated in place. The official image trusts local-socket connections,
    // so no old password is needed, and the new one rides in the exec's Env —
    // it appears in neither the container's Config.Env nor ExecInspect.
    // base64url passwords cannot break out of the SQL single quotes.
    const alterSql =
      "ALTER USER \\\"$POSTGRES_USER\\\" WITH PASSWORD '$SOHWE_NEW_PASSWORD'";
    const exit = await execInDatastore(
      docker,
      datastoreContainerName(ds.slug),
      [
        "sh",
        "-c",
        `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "${alterSql}"`
      ],
      [
        `POSTGRES_USER=${creds.username ?? "sohwe"}`,
        `SOHWE_NEW_PASSWORD=${newPassword}`
      ]
    );
    if (exit !== 0) {
      throw new Error("Password rotation failed: ALTER USER did not succeed");
    }
  } else {
    // requirepass is a server argument: recreate the container with the new
    // one. Data survives on the named volume; AOF persistence makes the
    // recreate durable.
    await startDatastoreContainer(docker, ds, newCreds);
    await waitUntilReady(docker, ds, newCreds);
  }

  // Persist last: a failure above leaves the old, still-valid credentials.
  const stored: Record<string, string> = { password: newCreds.password };
  if (newCreds.username) stored.username = newCreds.username;
  if (newCreds.database) stored.database = newCreds.database;
  await prisma.datastore.update({
    where: { id: ds.id },
    data: { credentialsEncrypted: encryptJson(stored) }
  });
  await rewriteBoundEnvKeys(ds, newCreds);
}

export type DatastoreSubsystem = {
  queue: Queue<DatastoreJobData>;
  worker: Worker<DatastoreJobData>;
  close: () => Promise<void>;
};

export async function startDatastoreSubsystem(
  docker: Docker
): Promise<DatastoreSubsystem> {
  const connection = getConnectionOptionsForBull();
  const queue = createDatastoreQueue();

  const worker = new Worker<DatastoreJobData>(
    DATASTORE_QUEUE,
    async (job) => {
      const { datastoreId } = job.data;
      try {
        if (job.name === DATASTORE_PROVISION_JOB) {
          await runProvision(docker, datastoreId);
        } else if (job.name === DATASTORE_DELETE_JOB) {
          await runDelete(docker, datastoreId);
        } else if (job.name === DATASTORE_ROTATE_JOB) {
          await runRotate(docker, datastoreId);
        }
      } catch (e) {
        // Defense in depth: no code path above puts a password into an error
        // message, but anything stored on the row is scrubbed anyway.
        const secrets: string[] = [];
        try {
          const ds = await loadDatastore(datastoreId);
          if (ds) secrets.push(readCreds(ds).password);
        } catch {
          // ignore
        }
        const msg = redactSecrets(e instanceof Error ? e.message : String(e), secrets);
        await prisma.datastore
          .update({
            where: { id: datastoreId },
            data: { status: "error", errorMessage: msg }
          })
          .catch(() => {});
        throw new Error(msg);
      }
    },
    { connection }
  );

  worker.on("failed", (job, err) => {
    console.error("Datastore job failed", job?.id, job?.name, err.message);
  });
  worker.on("error", (err) => {
    console.error("Datastore worker error", err);
  });

  return {
    queue,
    worker,
    close: async () => {
      await worker.close();
      await queue.close();
    }
  };
}
