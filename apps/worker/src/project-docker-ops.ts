import { DATASTORE_LABEL, projectInternalNetworkName } from "@sohwe/types";

type ProjectDocker = {
  createNetwork(opts: {
    Name: string;
    Driver: string;
    Internal: boolean;
    Labels: Record<string, string>;
  }): Promise<unknown>;
  getNetwork(name: string): {
    connect(opts: {
      Container: string;
      EndpointConfig?: { Aliases?: string[] };
    }): Promise<unknown>;
    disconnect(opts: { Container: string; Force: boolean }): Promise<unknown>;
  };
  listContainers(opts: {
    all: true;
    filters: { label: string[] };
  }): Promise<{ Id: string; Labels?: Record<string, string> }[]>;
  getContainer(id: string): {
    stop(opts: { t: number }): Promise<unknown>;
    remove(): Promise<unknown>;
  };
};

function statusCodeOf(error: unknown): number | undefined {
  return error && typeof error === "object" && "statusCode" in error
    ? Number((error as { statusCode?: number }).statusCode)
    : undefined;
}

/** Detach datastores whose bindings were removed, but only after a new
 * release has replaced every container that could still depend on them. */
export async function disconnectUnboundProjectDatastores(
  docker: ProjectDocker,
  projectId: string,
  boundDatastoreIds: ReadonlySet<string>
): Promise<void> {
  const rows = await docker.listContainers({
    all: true,
    filters: { label: [DATASTORE_LABEL] }
  });
  const network = docker.getNetwork(projectInternalNetworkName(projectId));
  for (const row of rows) {
    const datastoreId = row.Labels?.[DATASTORE_LABEL];
    if (!datastoreId || boundDatastoreIds.has(datastoreId)) continue;
    try {
      await network.disconnect({ Container: row.Id, Force: true });
    } catch (error) {
      // 403 means it was not attached; 404 means the network/container was
      // removed concurrently. Both already satisfy the desired state.
      const status = statusCodeOf(error);
      if (status !== 403 && status !== 404) throw error;
    }
  }
}

export async function ensureProjectNetwork(
  docker: ProjectDocker,
  projectId: string
): Promise<string> {
  const name = projectInternalNetworkName(projectId);
  try {
    await docker.createNetwork({
      Name: name,
      Driver: "bridge",
      // Isolated from other Sohwe projects and unexposed on the host, while
      // still allowing workers to reach external APIs and S3/R2.
      Internal: false,
      Labels: { "sohwe.managed": "true", "sohwe.project": projectId }
    });
  } catch (error) {
    // Docker reports 409 when it already exists. Some test doubles do not
    // carry status codes, so preserve the idempotent behavior of app networks.
    if (statusCodeOf(error) !== 409 && statusCodeOf(error) !== undefined) {
      throw error;
    }
  }
  return name;
}

export async function connectHttpServiceToRoutingNetwork(
  docker: ProjectDocker,
  routingNetwork: string,
  containerId: string
): Promise<void> {
  try {
    await docker.getNetwork(routingNetwork).connect({ Container: containerId });
  } catch (error) {
    if (statusCodeOf(error) !== 403) throw error;
  }
}

/** Remove project containers except an optional newly promoted release. */
export async function stopAndRemoveProjectContainers(
  docker: ProjectDocker,
  projectId: string,
  keepReleaseId?: string
): Promise<void> {
  const rows = await docker.listContainers({
    all: true,
    filters: { label: [`sohwe.project=${projectId}`] }
  });
  for (const row of rows) {
    if (keepReleaseId && row.Labels?.["sohwe.release"] === keepReleaseId) continue;
    const container = docker.getContainer(row.Id);
    await container.stop({ t: 10 }).catch(() => {});
    await container.remove().catch(() => {});
  }
}
