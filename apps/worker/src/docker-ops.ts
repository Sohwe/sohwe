import { appDockerVolumeName, appInternalNetworkName } from "@sohwe/types";

// The deploy path's imperative Docker calls, extracted from the worker
// entrypoint so they are testable against a Docker double. Behavior is
// deliberately identical to the inline originals:
//
// - stopping/removing old containers is best-effort per container, so one
//   wedged container cannot block a redeploy;
// - volume creation is inspect-then-create, idempotent across redeploys;
// - internal-network creation swallows "already exists", but the *connect*
//   error propagates — a container that cannot reach its internal network is
//   a failed deploy, not a warning.

/** The slice of dockerode these operations touch; a test double implements this. */
export type OpsDocker = {
  listContainers(opts: {
    all: true;
    filters: { label: string[] };
  }): Promise<{ Id: string }[]>;
  getContainer(id: string): {
    stop(opts: { t: number }): Promise<unknown>;
    remove(): Promise<unknown>;
  };
  getVolume(name: string): { inspect(): Promise<unknown> };
  createVolume(opts: {
    Name: string;
    Labels: Record<string, string>;
  }): Promise<unknown>;
  createNetwork(opts: {
    Name: string;
    Driver: string;
    Internal: boolean;
    Labels: Record<string, string>;
  }): Promise<unknown>;
  getNetwork(name: string): {
    connect(opts: { Container: string }): Promise<unknown>;
  };
};

/**
 * Stop (10s grace) and remove every container of an app, running or not.
 * Failures are swallowed per container and per step: a stop that times out
 * must not prevent the remove, and neither may fail the deploy replacing them.
 */
export async function stopAndRemoveAppContainers(
  docker: OpsDocker,
  appId: string
): Promise<void> {
  const existing = await docker.listContainers({
    all: true,
    filters: { label: [`sohwe.app=${appId}`] }
  });
  for (const c of existing) {
    const d = docker.getContainer(c.Id);
    await d.stop({ t: 10 }).catch(() => {});
    await d.remove().catch(() => {});
  }
}

/** Create any missing Docker named volumes for an app's volume rows. */
export async function ensureAppVolumes(
  docker: OpsDocker,
  appId: string,
  volumes: { id: string }[]
): Promise<void> {
  for (const v of volumes) {
    const vn = appDockerVolumeName(appId, v.id);
    try {
      await docker.getVolume(vn).inspect();
    } catch {
      await docker.createVolume({
        Name: vn,
        Labels: {
          "sohwe.managed": "true",
          "sohwe.app": appId,
          "sohwe.volume": v.id
        }
      });
    }
  }
}

/**
 * Idempotently create the app's internal bridge network and connect a
 * container to it. The create is allowed to fail (already exists); the
 * connect is not.
 */
export async function connectToInternalNetwork(
  docker: OpsDocker,
  appId: string,
  containerId: string
): Promise<void> {
  const name = appInternalNetworkName(appId);
  try {
    await docker.createNetwork({
      Name: name,
      Driver: "bridge",
      Internal: true,
      Labels: { "sohwe.managed": "true", "sohwe.app": appId }
    });
  } catch {
    // already exists
  }
  await docker.getNetwork(name).connect({ Container: containerId });
}
