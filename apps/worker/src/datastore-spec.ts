import type Docker from "dockerode";
import {
  DATASTORE_LABEL,
  datastoreContainerName,
  datastoreServicePort,
  datastoreVolumeName,
  type DatastoreKind
} from "@sohwe/types";
import { buildResourceLimits } from "./container-spec";

/**
 * How a managed datastore becomes a Docker container.
 *
 * Same idea as `container-spec.ts` for apps: everything here is a pure
 * decision — given the datastore row and its decrypted credentials, produce
 * the exact object handed to `docker.createContainer`. Nothing performs I/O
 * or reads `process.env`.
 *
 * Two deliberate differences from app containers:
 * - No `sohwe.app` label. The worker's stats sampler, crash watcher, and
 *   log-tail recovery all key off that label; its absence keeps datastores
 *   out of the per-app subsystems.
 * - No Traefik labels and no proxy network. A datastore is private by
 *   default; the provision job attaches it to bound apps' internal networks.
 *   `publicPort`, when set, publishes the service port on the host — the
 *   opt-in escape hatch for external access.
 */

export type DatastoreSpecInput = {
  id: string;
  slug: string;
  kind: DatastoreKind;
  engineVersion: string;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  /** Host port to publish the service on; null keeps the datastore private. */
  publicPort: number | null;
  /** Already-decrypted credentials from the row. */
  creds: { username?: string; password: string; database?: string };
};

/** Official image for a datastore, e.g. `postgres:16` / `redis:7`. */
export function datastoreImage(kind: DatastoreKind, engineVersion: string): string {
  return `${kind}:${engineVersion}`;
}

/** In-container path the data volume is mounted at, per kind. */
export function datastoreDataPath(kind: DatastoreKind): string {
  return kind === "postgres" ? "/var/lib/postgresql/data" : "/data";
}

export function buildDatastoreLabels(datastoreId: string): Record<string, string> {
  return {
    "sohwe.managed": "true",
    [DATASTORE_LABEL]: datastoreId
  };
}

/** The complete argument for `docker.createContainer`. */
export function buildDatastoreContainerSpec(
  input: DatastoreSpecInput
): Docker.ContainerCreateOptions {
  const { id, slug, kind, engineVersion, publicPort, creds } = input;
  const servicePort = datastoreServicePort(kind);
  const portKey = `${String(servicePort)}/tcp`;

  const spec: Docker.ContainerCreateOptions = {
    name: datastoreContainerName(slug),
    Image: datastoreImage(kind, engineVersion),
    Labels: buildDatastoreLabels(id),
    HostConfig: {
      // Created on the default bridge, never the Traefik proxy network. The
      // provision job connects bound apps' internal networks afterwards and
      // drops the bridge endpoint again unless the datastore is public
      // (published ports do not function on internal-only networks).
      RestartPolicy: { Name: "unless-stopped" },
      Binds: [`${datastoreVolumeName(id)}:${datastoreDataPath(kind)}`],
      ...buildResourceLimits(input)
    }
  };

  if (kind === "postgres") {
    spec.Env = [
      `POSTGRES_USER=${creds.username ?? "sohwe"}`,
      `POSTGRES_PASSWORD=${creds.password}`,
      `POSTGRES_DB=${creds.database ?? "sohwe"}`
    ];
  } else {
    // `requirepass` in Cmd is visible only through the Docker socket, which is
    // root-equivalent and already sees every app's decrypted Config.Env.
    spec.Cmd = ["redis-server", "--appendonly", "yes", "--requirepass", creds.password];
  }

  if (publicPort != null) {
    spec.ExposedPorts = { [portKey]: {} };
    spec.HostConfig!.PortBindings = {
      [portKey]: [{ HostIp: "0.0.0.0", HostPort: String(publicPort) }]
    };
  }

  return spec;
}
